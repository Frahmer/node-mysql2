var mysql = require('../index.js');

var EventEmitter = require('events').EventEmitter;
var Timers = require('timers');
var Util = require('util');
var PoolConnection = require('./pool_connection.js');
var Queue = require('denque');
var Connection = require('./connection.js');

module.exports = Pool;

Util.inherits(Pool, EventEmitter);
function Pool(options) {
  EventEmitter.call(this);
  this.config = options.config;
  this.config.connectionConfig.pool = this;

  this._allConnections = new Queue();
  this._freeConnections = new Queue();
  this._extraConnections = new Queue();
  this._connectionQueue = new Queue();
  this._closed = false;
}

Pool.prototype.getConnection = function(cb) {
  if (this._closed) {
    return process.nextTick(function() {
      return cb(new Error('Pool is closed.'));
    });
  }

  var connection;

  if (this._freeConnections.length > 0) {
    connection = this._freeConnections.shift();
  }

  if (!connection && this._extraConnections.length > 0) {
    connection = this._extraConnections.pop();
  }

  if (connection) {
    return process.nextTick(function() {
      return cb(null, connection);
    });
  }

  if (
    this.config.connectionLimit === 0 ||
    this._allConnections.length < this.config.connectionLimit
  ) {
    connection = new PoolConnection(this, {
      config: this.config.connectionConfig
    });
    this._startExpiredTimer();

    this._allConnections.push(connection);

    return connection.connect(
      function(err) {
        if (this._closed) {
          return cb(new Error('Pool is closed.'));
        }
        if (err) {
          return cb(err);
        }

        this.emit('connection', connection);
        return cb(null, connection);
      }.bind(this)
    );
  }

  if (!this.config.waitForConnections) {
    return process.nextTick(function() {
      return cb(new Error('No connections available.'));
    });
  }

  if (
    this.config.queueLimit &&
    this._connectionQueue.length >= this.config.queueLimit
  ) {
    return cb(new Error('Queue limit reached.'));
  }

  this.emit('enqueue');
  return this._connectionQueue.push(cb);
};

Pool.prototype.releaseConnection = function(connection) {
  var cb;

  if (!connection._pool) {
    // The connection has been removed from the pool and is no longer good.
    if (this._connectionQueue.length) {
      cb = this._connectionQueue.shift();

      process.nextTick(this.getConnection.bind(this, cb));
    }
  } else if (this._connectionQueue.length) {
    cb = this._connectionQueue.shift();

    process.nextTick(cb.bind(null, null, connection));
  } else {
    if (this._freeConnections.length >= this.config.minConnections) {
      connection._lastReleased = Date.now();
      this._extraConnections.push(connection);
    } else {
      this._freeConnections.push(connection);
    }
  }
};

Pool.prototype.end = function(cb) {
  this._closed = true;
  this._stopExpiredTimer();

  if (typeof cb != 'function') {
    cb = function(err) {
      if (err) {
        throw err;
      }
    };
  }

  var calledBack = false;
  var closedConnections = 0;
  var connection;

  var endCB = function(err) {
    if (calledBack) {
      return;
    }

    if (err || ++closedConnections >= this._allConnections.length) {
      calledBack = true;
      cb(err);
      return;
    }
  }.bind(this);

  if (this._allConnections.length === 0) {
    endCB();
    return;
  }

  for (var i = 0; i < this._allConnections.length; i++) {
    connection = this._allConnections.get(i);
    connection._realEnd(endCB);
  }
};

Pool.prototype.query = function(sql, values, cb) {
  var cmdQuery = Connection.createQuery(
    sql,
    values,
    cb,
    this.config.connectionConfig
  );
  cmdQuery.namedPlaceholders = this.config.connectionConfig.namedPlaceholders;

  this.getConnection(function(err, conn) {
    if (err) {
      if (typeof cmdQuery.onResult === 'function') {
        cmdQuery.onResult(err);
      } else {
        cmdQuery.emit('error', err);
      }
      return;
    }

    conn.query(cmdQuery).once('end', function() {
      conn.release();
    });
  });
  return cmdQuery;
};

Pool.prototype.execute = function(sql, values, cb) {
  var useNamedPlaceholders = this.config.connectionConfig.namedPlaceholders;

  // TODO construct execute command first here and pass it to connection.execute
  // so that polymorphic arguments logic is there in one place
  if (typeof values == 'function') {
    cb = values;
    values = [];
  }

  this.getConnection(function(err, conn) {
    if (err) {
      return cb(err);
    }

    const executeCmd = conn.execute(sql, values, cb);
    executeCmd.once('end', function() {
      conn.release();
    });
  });
};

Pool.prototype._startExpiredTimer = function() {
  if (!this._expiredTimer) {
    this._expiredTimer = Timers.setInterval(
        Pool.prototype._closeIdleConnections.bind(this),
        1000
    );
  }
};

Pool.prototype._stopExpiredTimer = function() {
  if (this._expiredTimer) {
      Timers.clearInterval(this._expiredTimer);
      this._expiredTimer = null;
  }
};

Pool.prototype._closeIdleConnections = function() {
  var now = Date.now();
  var timeout = this.config.idleTimeout * 1000;
  while (this._extraConnections.length) {
    var conn = this._extraConnections.peek();

    if (now > conn._lastReleased + timeout) {
      // This connection has been unused for longer than the timeout
      this._extraConnections.shift();
      conn.destroy();
    } else {
      break; // First will always be oldest, we are done
    }
  }
};

Pool.prototype._removeConnection = function(connection) {
  // Remove connection from all connections
  spliceConnection(this._allConnections, connection);

  // Remove connection from free connections
  spliceConnection(this._freeConnections, connection);

  // Remove connection from extra connections
  spliceConnection(this._extraConnections, connection);

  this.releaseConnection(connection);

  if (!this._allConnections.length) {
      this._stopExpiredTimer();
  }
};

Pool.prototype.escape = function(value) {
  return mysql.escape(
    value,
    this.config.connectionConfig.stringifyObjects,
    this.config.connectionConfig.timezone
  );
};

Pool.prototype.escapeId = function escapeId(value) {
  return mysql.escapeId(value, false);
};

function spliceConnection(queue, connection) {
  var len = queue.length;
  if (len) {
    if (queue.get(len - 1) === connection) {
      queue.pop();
    } else {
      for (; --len; ) {
        if (queue.get(0) === connection) {
          queue.shift();
          break;
        }
        queue.push(queue.shift());
      }
    }
  }
}
