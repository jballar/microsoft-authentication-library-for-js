/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ClientConfiguration, buildClientConfiguration } from "../config/ClientConfiguration";
import { INetworkModule } from "../network/INetworkModule";
import { NetworkManager, NetworkResponse } from "../network/NetworkManager";
import { ICrypto } from "../crypto/ICrypto";
import { Authority } from "../authority/Authority";
import { Logger } from "../logger/Logger";
import { AADServerParamKeys, Constants, HeaderNames } from "../utils/Constants";
import { ServerAuthorizationTokenResponse } from "../response/ServerAuthorizationTokenResponse";
import { TrustedAuthority } from "../authority/TrustedAuthority";
import { CacheManager } from "../cache/CacheManager";
import { ServerTelemetryManager } from "../telemetry/server/ServerTelemetryManager";
import { RequestThumbprint } from "../network/RequestThumbprint";

/**
 * Base application class which will construct requests to send to and handle responses from the Microsoft STS using the authorization code flow.
 */
export abstract class BaseClient {
    // Logger object
    public logger: Logger;

    // Application config
    protected config: ClientConfiguration;

    // Crypto Interface
    protected cryptoUtils: ICrypto;

    // Storage Interface
    protected cacheManager: CacheManager;

    // Network Interface
    protected networkClient: INetworkModule;

    // Server Telemetry Manager
    protected serverTelemetryManager: ServerTelemetryManager;

    // Network Manager
    protected networkManager: NetworkManager;

    // Default authority object
    protected authority: Authority;

    protected constructor(configuration: ClientConfiguration) {
        // Set the configuration
        this.config = buildClientConfiguration(configuration);

        // Initialize the logger
        this.logger = new Logger(this.config.loggerOptions);

        // Initialize crypto
        this.cryptoUtils = this.config.cryptoInterface;

        // Initialize storage interface
        this.cacheManager = this.config.storageInterface;

        // Set the network interface
        this.networkClient = this.config.networkInterface;

        // Set the NetworkManager
        this.networkManager = new NetworkManager(this.networkClient, this.cacheManager);

        // Set TelemetryManager
        this.serverTelemetryManager = this.config.serverTelemetryManager;

        TrustedAuthority.setTrustedAuthoritiesFromConfig(this.config.authOptions.knownAuthorities, this.config.authOptions.cloudDiscoveryMetadata);

        this.authority = this.config.authOptions.authority;
    }

    /**
     * Creates default headers for requests to token endpoint
     */
    protected createDefaultTokenRequestHeaders(): Record<string, string> {
        /*
         * GBL: TBR
         * Workaround to remove most of the headers in the request
         * This allows for proper operation when using the ADFS Proxy.     * const headers = this.createDefaultLibraryHeaders();
         */

        const headers : Record<string, string> = {};

        this.logger.info("(GBL)BaseClient::createDefaultTokenRequestHeaders: removed headers -> No preflight (ADFS Proxy workaround)");

        headers[HeaderNames.CONTENT_TYPE] = Constants.URL_FORM_CONTENT_TYPE;

        /*
         * GBL: TBR
         * Continue ADFS Proxy workaround
         * headers[HeaderNames.X_MS_LIB_CAPABILITY] = HeaderNames.X_MS_LIB_CAPABILITY_VALUE;
         * if (this.serverTelemetryManager) {
         *    headers[HeaderNames.X_CLIENT_CURR_TELEM] = this.serverTelemetryManager.generateCurrentRequestHeaderValue();
         *    headers[HeaderNames.X_CLIENT_LAST_TELEM] = this.serverTelemetryManager.generateLastRequestHeaderValue();
         * }
         */

        return headers;
    }

    /**
     * addLibraryData
     */
    protected createDefaultLibraryHeaders(): Record<string, string> {
        const headers: Record<string, string> = {};

        // client info headers
        headers[AADServerParamKeys.X_CLIENT_SKU] = this.config.libraryInfo.sku;
        headers[AADServerParamKeys.X_CLIENT_VER] = this.config.libraryInfo.version;
        headers[AADServerParamKeys.X_CLIENT_OS] = this.config.libraryInfo.os;
        headers[AADServerParamKeys.X_CLIENT_CPU] = this.config.libraryInfo.cpu;

        return headers;
    }

    /**
     * Http post to token endpoint
     * @param tokenEndpoint
     * @param queryString
     * @param headers
     * @param thumbprint
     */
    protected async executePostToTokenEndpoint(tokenEndpoint: string, queryString: string, headers: Record<string, string>, thumbprint: RequestThumbprint): Promise<NetworkResponse<ServerAuthorizationTokenResponse>> {
        const response = await this.networkManager.sendPostRequest<ServerAuthorizationTokenResponse>(
            thumbprint,
            tokenEndpoint, 
            { body: queryString, headers: headers }
        );

        if (this.config.serverTelemetryManager && response.status < 500 && response.status !== 429) {
            // Telemetry data successfully logged by server, clear Telemetry cache
            this.config.serverTelemetryManager.clearTelemetryCache();
        }

        return response;
    }
}
