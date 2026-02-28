import { GatewayClient } from './gateway-client.js';

const DEFAULT_GATEWAY_URL = 'ws://localhost:18789';

export const gateway = new GatewayClient(DEFAULT_GATEWAY_URL);
