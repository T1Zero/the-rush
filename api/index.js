// Vercel serverless entry — all /api/* requests are routed here by vercel.json.
const { handleApi } = require('../lib/api');
const store = require('../lib/store');

module.exports = (req, res) => handleApi(req, res, store);
