// vercel entry — the platform imports this module and calls the express app
// as a handler. everything (routes, static, errors) lives in server/index.js.
import app from '../server/index.js';

export default app;
