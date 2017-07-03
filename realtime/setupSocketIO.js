/**
 * Copyright (c) 2016, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or
 * https://opensource.org/licenses/BSD-3-Clause
 */

/**
 * ./realTime/setupSocketIO.js
 *
 * Initialize socket.io for sending realtime events out to perspective pages.
 */
'use strict'; // eslint-disable-line strict
const ResourceNotFoundError = require('../db/dbErrors').ResourceNotFoundError;
const perspective = require('../db/index').Perspective;
const featureToggles = require('feature-toggles');
const rtUtils = require('./utils');
const redisClient = require('../cache/redisCache').client.realtimeLogging;
const conf = require('../config');
const ipWhitelist = conf.environment[conf.nodeEnv].ipWhitelist;
const activityLogUtil = require('../utils/activityLog');
const logEnabled =
  featureToggles.isFeatureEnabled('enableRealtimeActivityLogs');
const ONE = 1;
const SID_REX = /connect.sid=s%3A([^\.]*)\./;
const activePerspPrefix = 'activePersp:';

/**
 * Load the authenticated user name from the session id.
 *
 * @param {String} sid - The session id from the cookie
 * @param {Object} redisStore - The RedisStore object
 * @param {String} username, or empty string if requireAccessToken is turned
 *  off
 * @throws {Error} missing session or user name
 */
function getUserFromSession(sid, redisStore) {
  return new Promise((resolve, reject) => {
    if (featureToggles.isFeatureEnabled('requireAccessToken')) {
      redisStore.get(sid, (err, sessionData) => {
        if (err) {
          reject(err);
        } else if (sessionData && sessionData.passport &&
        sessionData.passport.user && sessionData.passport.user.name) {
          resolve(sessionData.passport.user.name);
        } else {
          reject(new Error('Expecting valid session'));
        }
      });
    } else {
      resolve('');
    }
  });
} // getUserFromSession

/**
 * Fetches all the perspectives and calls initializeNamespace to initialize
 * a socketIO namespace for each one.
 *
 * @param {Socket.io} io - The socket.io server-side object.
 * @returns {Promise} - Returns a promise that resolves to the socket.io
 *  server-side object with the namespace initialized.
 */
function setupNamespace(io) {
  return new Promise((resolve, reject) => {
    // get all keys starting with activePersp: from redis
    redisClient.keysAsync(`${activePerspPrefix}*`)
    .then((keys) => {
      const promiseArr = [];
      keys.forEach((key) => {
        const promise = redisClient.getAsync(key)
          .then((numOpenClients) => {
            numOpenClients = parseInt(numOpenClients);
            // redis key example, activePersp:nameOfPerspective
            const keySplitArr = key.split(':');

            /*
             If number of open clients for a perspective are > 0 and valid
              key, get the perspective object from db and initialize namespace.
            */
            if ((keySplitArr.length > 1)) {
              const perspName = keySplitArr[1];
              perspective.findOne({ where: { name: perspName } })
              .then((perspObj) => {
                if (perspObj) {
                  rtUtils.initializeNamespace(perspObj, io);
                } else {
                  const err = new ResourceNotFoundError();
                  err.resourceType = 'Perspective';
                  throw err;
                }
              });
            }
          });
        promiseArr.push(promise);
      });

      Promise.all(promiseArr)
      .then(() => {
        resolve(io);
      })
      .catch(reject);
    })
    .catch(reject);
  });
} // setupNamespace

/**
 * Retrieve logging info for socket from redis and print realtime logs.
 * @param  {Object} socket - Socket object
 */
function printRealtimeLogs(socket) {
  // Retrieve the logging info for this socket.
  redisClient.get(socket.id, (getErr, getResp) => {
    if (getErr) {
      console.log('Error ' + // eslint-disable-line no-console
        `retrieving socket id ${socket.id} from redis on client ` +
        'disconnect:', getErr);
    } else { // eslint-disable-line lines-around-comment
      /*
       * Calculate the totalTime and write out the log line. If redis
       * was flushed by an admin, the response here will be empty, so
       * just skip the logging.
       */
      const d = JSON.parse(getResp);
      if (d && d.starttime) {
        d.totalTime = (Date.now() - d.starttime) + 'ms';
        activityLogUtil.printActivityLogString(d, 'realtime');
      }

      // Remove the redis key for this socket.
      redisClient.del(socket.id, (delErr, delResp) => {
        if (delErr) {
          console.log('Error ' + // eslint-disable-line no-console
            `deleting socket id ${socket.id} from redis on ` +
            'client disconnect:', delErr);
        } else if (delResp !== ONE) {
          console.log('Expecting' + // eslint-disable-line no-console
            `unique socket id ${socket.id} to delete from redis on ` +
            `client disconnect, but ${delResp} were deleted.`);
        }
      }); // redisClient.del
    }
  }); // redisClient.get
}

/**
 * Set up a namespace for each perspective. On socket connect, start tracking
 * information about the socket for realtime activity logging. On socket
 * disconnect, write out the activity log.
 *
 * @param {Socket.io} io - socket.io's server-side object
 * @returns {Promise} - Returns a promise that resolves to the socket.io
 *  server-side object with the namespace initialized. (This is returned for
 *  testability.)
 */
function init(io, redisStore) {
  io.sockets.on('connection', (socket) => {
    // console.log('IO namespaces on connect >>', io.nsps);
    // Socket handshake must have "cookie" header with connect.sid.
    if (!socket.handshake.headers.cookie) {
      // disconnecting socket -- expecting header with cookie
      // console.log('[WSDEBUG] disconnecting socket -- expecting header ' +
      //   'with cookie');
      socket.disconnect();
      return;
    } // no cookie

    // Pull the sesssion id off the cookie.
    const sidMatch = SID_REX.exec(socket.handshake.headers.cookie);
    if (!sidMatch || sidMatch.length < 2) {
      // disconnecting socket -- expecting session id in cookie header
      // console.log('[WSDEBUG] disconnecting socket -- expecting session ' +
      //   'id in cookie header');
      socket.disconnect();
      return;
    }

    // Load the session from redisStore.
    const sid = sidMatch[1];

    // console.log('[WSDEBUG] cookie', socket.handshake.headers.cookie);
    // console.log('[WSDEBUG] sid', sid);
    getUserFromSession(sid, redisStore)
    .then((user) => {

      // OK, we've got a user from the session!
      let ipAddress;

      // Get IP address and perspective name from socket handshake.
      if (socket.handshake) {
        if (socket.handshake.headers &&
        socket.handshake.headers['x-forwarded-for']) {
          ipAddress = socket.handshake.headers['x-forwarded-for'];

          // console.log('[IPDEBUG] socket.handshake.headers' +
          //   '[x-forwarded-for]', ipAddress);
        } else if (socket.handshake.address) {
          // console.log('[IPDEBUG] socket.handshake.address', ipAddress);
          ipAddress = socket.handshake.address;
        }

        rtUtils.isIpWhitelisted(ipAddress, ipWhitelist); // throws error
      } else {
        throw new Error('disconnecting socket: could not identify ip address');
      }

      if (logEnabled) {
        const toLog = {
          ipAddress,
          starttime: Date.now(),
          user: user,
        };

        if (socket.handshake.query && socket.handshake.query.p) {
          toLog.perspective = socket.handshake.query.p;
        }

        redisClient.set(socket.id, JSON.stringify(toLog));
      }

      const perspName = socket.handshake.query.p;
      const perspKey = `${activePerspPrefix}${perspName}`;

      socket.on('disconnect', () => {
        /*
          Get the perspective entry from redis. If the number of open clients
          were <=1, then delete entry from redis, and get the perspective object
          from db and delete the namespace from socket io and . Else, reduce
          the number of clients in redis.
         */
        redisClient.getAsync(perspKey)
        .then((numOfConn) => {
          if (numOfConn <= ONE) { // delete namespace and redis entry
            return redisClient.delAsync(perspKey)
            .then(() => perspective.findOne({ where: { name: perspName } }))
            .then((perspObj) => {
              if (perspObj) {
                return rtUtils.deleteNamespace(perspObj, io);
              }

              const err = new ResourceNotFoundError();
              err.resourceType = 'Perspective';
              throw err;
            });
          }

          // If number of conn > 1, decrement the number in redis
          return redisClient.decrAsync(perspKey);
        });

        if (logEnabled) {
          printRealtimeLogs(socket);
        } // if logEnabled
      }); // on disconnect

      // init namespace with all persp value 0, the on pub, go thru all and
      // send only if 1.

      /*
        Check the current open perspective in redis. If the entry does not
        exist in redis, that means it is opened by first client. Get the
        perspective from db and initialize namespace.
       */
      // return setupNamespace(io) // executes only when server starts.
      return redisClient.getAsync(perspKey) // update the new conn in redis
      .then((numOfClients) => {
        if (!numOfClients) {
          return perspective.findOne({ where: { name: perspName } })
          .then((perspObj) => {
            if (perspObj) {
              return rtUtils.initializeNamespace(perspObj, io);
            }

            const err = new ResourceNotFoundError();
            err.resourceType = 'Perspective';
            throw err;
          })
          .then(() => {
            console.log('IO after init namespace for new persp >>>>', io.nsps);
            return redisClient.incrAsync(perspKey);
          });
        }

        // only increament the key
        return redisClient.incrAsync(perspKey);
      });
    })
    .catch(() => {
      // no realtime events :(
      // console.log('[WSDEBUG] caught error', err);
      socket.disconnect();
      return;
    });
  }); // on connect

  console.log('Calling setupNamespace....');
  return setupNamespace(io); // executes only when server starts.
} // init

module.exports = {
  init,
};
