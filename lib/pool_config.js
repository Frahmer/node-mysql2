var ConnectionConfig = require('./connection_config.js');

module.exports = PoolConfig;
function PoolConfig(options) {
  if (typeof options === 'string') {
    options = ConnectionConfig.parseUrl(options);
  }
  this.connectionConfig = new ConnectionConfig(options);
  this.waitForConnections =
    options.waitForConnections == null
      ? true
      : Boolean(options.waitForConnections);
  this.connectionLimit =
    options.connectionLimit == null ? 10 : Number(options.connectionLimit);
  this.queueLimit = options.queueLimit == null ? 0 : Number(options.queueLimit);
  this.minConnections = Math.min(
    this.connectionLimit,
    options.minConnections == null
      ? this.connectionLimit
      : Number(options.minConnections)
  );
  this.idleTimeout = Math.max(
    15,
    options.idleTimeout == null ? 300 : Number(options.idleTimeout)
  );
}
