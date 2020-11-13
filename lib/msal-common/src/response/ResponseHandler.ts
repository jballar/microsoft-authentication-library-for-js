/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ServerAuthorizationTokenResponse } from "./ServerAuthorizationTokenResponse";
import { buildClientInfo, ClientInfo } from "../account/ClientInfo";
import { ICrypto } from "../crypto/ICrypto";
import { ClientAuthError } from "../error/ClientAuthError";
import { StringUtils } from "../utils/StringUtils";
import { ServerAuthorizationCodeResponse } from "./ServerAuthorizationCodeResponse";
import { Logger } from "../logger/Logger";
import { ServerError } from "../error/ServerError";
import { AuthToken } from "../account/AuthToken";
import { ScopeSet } from "../request/ScopeSet";
import { TimeUtils } from "../utils/TimeUtils";
import { AuthenticationResult } from "./AuthenticationResult";
import { AccountEntity } from "../cache/entities/AccountEntity";
import { Authority } from "../authority/Authority";
import { AuthorityType } from "../authority/AuthorityType";
import { IdTokenEntity } from "../cache/entities/IdTokenEntity";
import { AccessTokenEntity } from "../cache/entities/AccessTokenEntity";
import { RefreshTokenEntity } from "../cache/entities/RefreshTokenEntity";
import { InteractionRequiredAuthError } from "../error/InteractionRequiredAuthError";
import { CacheRecord } from "../cache/entities/CacheRecord";
import { CacheManager } from "../cache/CacheManager";
import { ProtocolUtils, LibraryStateObject, RequestStateObject } from "../utils/ProtocolUtils";
import { AuthenticationScheme } from "../utils/Constants";
import { PopTokenGenerator } from "../crypto/PopTokenGenerator";
import { AppMetadataEntity } from "../cache/entities/AppMetadataEntity";
import { ICachePlugin } from "../cache/interface/ICachePlugin";
import { TokenCacheContext } from "../cache/persistence/TokenCacheContext";
import { ISerializableTokenCache } from "../cache/interface/ISerializableTokenCache";

/**
 * Class that handles response parsing.
 */
export class ResponseHandler {
    private clientId: string;
    private cacheStorage: CacheManager;
    private cryptoObj: ICrypto;
    private logger: Logger;
    private clientInfo: ClientInfo;
    private homeAccountIdentifier: string;
    private serializableCache: ISerializableTokenCache;
    private persistencePlugin: ICachePlugin;

    constructor(clientId: string, cacheStorage: CacheManager, cryptoObj: ICrypto, logger: Logger, serializableCache?: ISerializableTokenCache, persistencePlugin?: ICachePlugin) {
        this.clientId = clientId;
        this.cacheStorage = cacheStorage;
        this.cryptoObj = cryptoObj;
        this.logger = logger;
        this.serializableCache = serializableCache;
        this.persistencePlugin = persistencePlugin;
    }

    /**
     * Function which validates server authorization code response.
     * @param serverResponseHash
     * @param cachedState
     * @param cryptoObj
     */
    validateServerAuthorizationCodeResponse(serverResponseHash: ServerAuthorizationCodeResponse, cachedState: string, cryptoObj: ICrypto): void {
        if (decodeURIComponent(serverResponseHash.state) !== decodeURIComponent(cachedState)) {
            throw ClientAuthError.createStateMismatchError();
        }

        // Check for error
        if (serverResponseHash.error || serverResponseHash.error_description || serverResponseHash.suberror) {
            if (InteractionRequiredAuthError.isInteractionRequiredError(serverResponseHash.error, serverResponseHash.error_description, serverResponseHash.suberror)) {
                throw new InteractionRequiredAuthError(serverResponseHash.error, serverResponseHash.error_description, serverResponseHash.suberror);
            }

            throw new ServerError(serverResponseHash.error, serverResponseHash.error_description, serverResponseHash.suberror);
        }

        if (serverResponseHash.client_info) {
            buildClientInfo(serverResponseHash.client_info, cryptoObj);
        }
    }

    /**
     * Function which validates server authorization token response.
     * @param serverResponse
     */
    validateTokenResponse(serverResponse: ServerAuthorizationTokenResponse): void {
        // Check for error
        if (serverResponse.error || serverResponse.error_description || serverResponse.suberror) {
            if (InteractionRequiredAuthError.isInteractionRequiredError(serverResponse.error, serverResponse.error_description, serverResponse.suberror)) {
                throw new InteractionRequiredAuthError(serverResponse.error, serverResponse.error_description, serverResponse.suberror);
            }

            const errString = `${serverResponse.error_codes} - [${serverResponse.timestamp}]: ${serverResponse.error_description} - Correlation ID: ${serverResponse.correlation_id} - Trace ID: ${serverResponse.trace_id}`;
            throw new ServerError(serverResponse.error, errString);
        }
    }

    /**
     * Returns a constructed token response based on given string. Also manages the cache updates and cleanups.
     * @param serverTokenResponse
     * @param authority
     */
    async handleServerTokenResponse(
        serverTokenResponse: ServerAuthorizationTokenResponse,
        authority: Authority,
        resourceRequestMethod?: string,
        resourceRequestUri?: string,
        cachedNonce?: string,
        cachedState?: string,
        requestScopes?: string[],
        oboAssertion?: string,
        handlingRefreshTokenResponse?: boolean): Promise<AuthenticationResult> {

        // generate homeAccountId
        if (serverTokenResponse.client_info) {
            this.clientInfo = buildClientInfo(serverTokenResponse.client_info, this.cryptoObj);
            if (!StringUtils.isEmpty(this.clientInfo.uid) && !StringUtils.isEmpty(this.clientInfo.utid)) {
                this.homeAccountIdentifier = `${this.clientInfo.uid}.${this.clientInfo.utid}`;
            }
        } else {
            this.logger.verbose("No client info in response");
            this.homeAccountIdentifier = "";
        }

        let idTokenObj: AuthToken = null;
        if (!StringUtils.isEmpty(serverTokenResponse.id_token)) {
            // create an idToken object (not entity)
            idTokenObj = new AuthToken(serverTokenResponse.id_token, this.cryptoObj);

            // token nonce check (TODO: Add a warning if no nonce is given?)
            if (!StringUtils.isEmpty(cachedNonce)) {
                if (idTokenObj.claims.nonce !== cachedNonce) {
                    throw ClientAuthError.createNonceMismatchError();
                }
            }
        }

        /*
         * GBL: TBR
         * Workaround to compute the correct Home Account Id
         * This allows the token cache to function properly when using ADFS
         */

        if (!this.homeAccountIdentifier) {
            this.logger.info("(GBL)ResponseHandler::handleServerTokenResponse: Home Account Id is missing - Trying using sub claim");
            if (Boolean(idTokenObj) && Boolean(idTokenObj.claims) && Boolean(idTokenObj.claims.sub)) {
                const tokenSub = idTokenObj.claims.sub;
                this.logger.info(`\thomeAccountIdentifier = sub = ${tokenSub}`);
                this.homeAccountIdentifier = tokenSub;
            } else {
                this.logger.info("(GBL)ResponseHandler::handleServerTokenResponse: sub claim is missing. Home Account Id is still invalid!!!");
            }
        }

        // save the response tokens
        let requestStateObj: RequestStateObject = null;
        if (!StringUtils.isEmpty(cachedState)) {
            requestStateObj = ProtocolUtils.parseRequestState(this.cryptoObj, cachedState);
        }

        const cacheRecord = this.generateCacheRecord(serverTokenResponse, idTokenObj, authority, requestStateObj && requestStateObj.libraryState, requestScopes, oboAssertion);
        let cacheContext;
        try {
            if (this.persistencePlugin && this.serializableCache) {
                this.logger.verbose("Persistence enabled, calling beforeCacheAccess");
                cacheContext = new TokenCacheContext(this.serializableCache, true);
                await this.persistencePlugin.beforeCacheAccess(cacheContext);
            }
            /*
             * When saving a refreshed tokens to the cache, it is expected that the account that was used is present in the cache.
             * If not present, we should return null, as it's the case that another application called removeAccount in between
             * the calls to getAllAccounts and acquireTokenSilent. We should not overwrite that removal. 
             */
            if (handlingRefreshTokenResponse && cacheRecord.account) {
                const key = cacheRecord.account.generateAccountKey();
                const account = this.cacheStorage.getAccount(key);
                if (!account) {
                    this.logger.warning("Account used to refresh tokens not in persistence, refreshed tokens will not be stored in the cache");
                    return null;
                }
            }
            this.cacheStorage.saveCacheRecord(cacheRecord);
        } finally {
            if (this.persistencePlugin && this.serializableCache && cacheContext) {
                this.logger.verbose("Persistence enabled, calling afterCacheAccess");
                await this.persistencePlugin.afterCacheAccess(cacheContext);
            }
        }
        return ResponseHandler.generateAuthenticationResult(this.cryptoObj, cacheRecord, idTokenObj, false, requestStateObj, resourceRequestMethod, resourceRequestUri);
    }

    /**
     * Generates CacheRecord
     * @param serverTokenResponse
     * @param idTokenObj
     * @param authority
     */
    private generateCacheRecord(serverTokenResponse: ServerAuthorizationTokenResponse, idTokenObj: AuthToken, authority: Authority, libraryState?: LibraryStateObject, requestScopes?: string[], oboAssertion?: string): CacheRecord {

        const env = Authority.generateEnvironmentFromAuthority(authority);

        if (StringUtils.isEmpty(env)) {
            throw ClientAuthError.createInvalidCacheEnvironmentError();
        }

        // IdToken: non AAD scenarios can have empty realm
        let cachedIdToken: IdTokenEntity = null;
        let cachedAccount: AccountEntity = null;
        if (!StringUtils.isEmpty(serverTokenResponse.id_token)) {
            cachedIdToken = IdTokenEntity.createIdTokenEntity(
                this.homeAccountIdentifier,
                env,
                serverTokenResponse.id_token,
                this.clientId,
                idTokenObj.claims.tid || "",
                oboAssertion
            );

            cachedAccount = this.generateAccountEntity(
                serverTokenResponse,
                idTokenObj,
                authority,
                oboAssertion
            );
        }

        // AccessToken
        let cachedAccessToken: AccessTokenEntity = null;
        if (!StringUtils.isEmpty(serverTokenResponse.access_token)) {

            // If scopes not returned in server response, use request scopes
            const responseScopes = serverTokenResponse.scope ? ScopeSet.fromString(serverTokenResponse.scope) : new ScopeSet(requestScopes || []);

            // Expiration calculation
            const currentTime = TimeUtils.nowSeconds();

            // If the request timestamp was sent in the library state, use that timestamp to calculate expiration. Otherwise, use current time.
            const timestamp = libraryState ? libraryState.ts : currentTime;
            const tokenExpirationSeconds = timestamp + serverTokenResponse.expires_in;
            const extendedTokenExpirationSeconds = tokenExpirationSeconds + serverTokenResponse.ext_expires_in;

            // non AAD scenarios can have empty realm
            cachedAccessToken = AccessTokenEntity.createAccessTokenEntity(
                this.homeAccountIdentifier,
                env,
                serverTokenResponse.access_token,
                this.clientId,
                idTokenObj ? idTokenObj.claims.tid || "" : authority.tenant,
                responseScopes.printScopes(),
                tokenExpirationSeconds,
                extendedTokenExpirationSeconds,
                serverTokenResponse.token_type,
                oboAssertion
            );
        }

        // refreshToken
        let cachedRefreshToken: RefreshTokenEntity = null;
        if (!StringUtils.isEmpty(serverTokenResponse.refresh_token)) {
            cachedRefreshToken = RefreshTokenEntity.createRefreshTokenEntity(
                this.homeAccountIdentifier,
                env,
                serverTokenResponse.refresh_token,
                this.clientId,
                serverTokenResponse.foci,
                oboAssertion
            );
        }

        // appMetadata
        let cachedAppMetadata: AppMetadataEntity = null;
        if (!StringUtils.isEmpty(serverTokenResponse.foci)) {
            cachedAppMetadata = AppMetadataEntity.createAppMetadataEntity(this.clientId, env, serverTokenResponse.foci);
        }

        return new CacheRecord(cachedAccount, cachedIdToken, cachedAccessToken, cachedRefreshToken, cachedAppMetadata);
    }

    /**
     * Generate Account
     * @param serverTokenResponse
     * @param idToken
     * @param authority
     */
    private generateAccountEntity(serverTokenResponse: ServerAuthorizationTokenResponse, idToken: AuthToken, authority: Authority, oboAssertion?: string): AccountEntity {
        const authorityType = authority.authorityType;

        // ADFS does not require client_info in the response
        if (authorityType === AuthorityType.Adfs) {
            this.logger.verbose("Authority type is ADFS, creating ADFS account");
            return AccountEntity.createGenericAccount(authority, idToken, oboAssertion);
        }

        // This fallback applies to B2C as well as they fall under an AAD account type.
        if (StringUtils.isEmpty(serverTokenResponse.client_info) && authority.protocolMode === "AAD") {
            throw ClientAuthError.createClientInfoEmptyError(serverTokenResponse.client_info);
        }

        return serverTokenResponse.client_info ?
            AccountEntity.createAccount(serverTokenResponse.client_info, authority, idToken, this.cryptoObj, oboAssertion) :
            AccountEntity.createGenericAccount(authority, idToken, oboAssertion);
    }

    /**
     * Creates an @AuthenticationResult from @CacheRecord , @IdToken , and a boolean that states whether or not the result is from cache.
     *
     * Optionally takes a state string that is set as-is in the response.
     *
     * @param cacheRecord
     * @param idTokenObj
     * @param fromTokenCache
     * @param stateString
     */
    static async generateAuthenticationResult(cryptoObj: ICrypto, cacheRecord: CacheRecord, idTokenObj: AuthToken, fromTokenCache: boolean, requestState?: RequestStateObject, resourceRequestMethod?: string, resourceRequestUri?: string): Promise<AuthenticationResult> {
        let accessToken: string = "";
        let responseScopes: Array<string> = [];
        let expiresOn: Date = null;
        let extExpiresOn: Date = null;
        let familyId: string = null;
        if (cacheRecord.accessToken) {
            if (cacheRecord.accessToken.tokenType === AuthenticationScheme.POP) {
                const popTokenGenerator: PopTokenGenerator = new PopTokenGenerator(cryptoObj);
                accessToken = await popTokenGenerator.signPopToken(cacheRecord.accessToken.secret, resourceRequestMethod, resourceRequestUri);
            } else {
                accessToken = cacheRecord.accessToken.secret;
            }
            responseScopes = ScopeSet.fromString(cacheRecord.accessToken.target).asArray();
            expiresOn = new Date(Number(cacheRecord.accessToken.expiresOn) * 1000);
            extExpiresOn = new Date(Number(cacheRecord.accessToken.extendedExpiresOn) * 1000);
        }
        if (cacheRecord.appMetadata) {
            familyId = cacheRecord.appMetadata.familyId || null;
        }
        const uid = idTokenObj ? idTokenObj.claims.oid || idTokenObj.claims.sub : "";
        const tid = idTokenObj ? idTokenObj.claims.tid : "";
        return {
            uniqueId: uid,
            tenantId: tid,
            scopes: responseScopes,
            account: cacheRecord.account ? cacheRecord.account.getAccountInfo() : null,
            idToken: idTokenObj ? idTokenObj.rawToken : "",
            idTokenClaims: idTokenObj ? idTokenObj.claims : null,
            accessToken: accessToken,
            fromCache: fromTokenCache,
            expiresOn: expiresOn,
            extExpiresOn: extExpiresOn,
            familyId: familyId,
            tokenType: cacheRecord.accessToken ? cacheRecord.accessToken.tokenType : "",
            state: requestState ? requestState.userRequestState : ""
        };
    }
}
