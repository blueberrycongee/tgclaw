import { GatewayClient } from './gateway-client.js';

const DEFAULT_GATEWAY_URL = 'ws://localhost:18789';
const DEFAULT_NODE_COMMANDS = ['system.run', 'system.execApprovals.get', 'system.execApprovals.set'];

// Operator connection - for sending messages, managing sessions
export const gateway = new GatewayClient(DEFAULT_GATEWAY_URL, {
  role: 'operator',
  clientId: 'cli',
  clientMode: 'ui',
});

// Node connection - for receiving exec requests
export const nodeGateway = new GatewayClient(DEFAULT_GATEWAY_URL, {
  role: 'node',
  clientId: 'node-host',
  clientMode: 'node',
  commands: DEFAULT_NODE_COMMANDS,
});
