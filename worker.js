// BlueChat Sync Server - Worker entrypoint
import { handleRequest } from './sync-server.js';

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};
