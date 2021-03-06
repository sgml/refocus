/**
 * Copyright (c) 2016, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or
 * https://opensource.org/licenses/BSD-3-Clause
 */

/**
 * db/helpers/aspectUtils.js
 *
 * Used by the Aspect model.
 */
'use strict'; // eslint-disable-line strict

const sampleEvent = require('../../realtime/constants').events.sample;
const InvalidRangeValuesError = require('../dbErrors').InvalidRangeValuesError;
const InvalidRangeSizeError = require('../dbErrors').InvalidRangeSizeError;
const redisOps = require('../../cache/redisOps');
const publishSample = require('../../realtime/redisPublisher').publishSample;
const aspSubMapType = redisOps.aspSubMapType;

/**
 * Confirms that the array is non-null and has two elements.
 *
 * @param {Array} arr - The array to test
 * @returns {undefined} - OK
 * @throws {InvalidRangeSizeError} if the array does not contain two elements
 */
function arrayHasTwoElements(arr) {
  if (arr && arr.length !== 2) {
    throw new InvalidRangeSizeError();
  }
} // arrayHasTwoElements

/**
 * Confirms that the array elements are not themselves arrays.
 *
 * @param {Array} arr - The array to test
 * @returns {undefined} - OK
 * @throws {InvalidRangeValuesError} if the array values are arrays
 */
function noNestedArrays(arr) {
  if (Array.isArray(arr[0]) || Array.isArray(arr[1])) {
    throw new InvalidRangeValuesError();
  }
} // noNestedArrays

/**
 * Confirms that the array elements are numeric.
 *
 * @param {Array} arr - The array to test
 * @returns {undefined} - OK
 * @throws {InvalidRangeValuesError} if the array values are not numeric
 */
function valuesAreNumeric(arr) {
  if (typeof arr[0] !== 'number' || typeof arr[1] !== 'number') {
    throw new InvalidRangeValuesError();
  }
} // noObjectsInRange

/**
 * Confirms that the second element in the array is greater than or equal to
 * the first element.
 *
 * @param {Array} arr - The array to test
 * @returns {undefined} - OK
 * @throws {InvalidRangeValuesError} if the array elements are not in
 *  ascending order
 */
function arrayValuesAscend(arr) {
  if (arr[0] > arr[1]) {
    throw new InvalidRangeValuesError();
  }
} // arrayValuesAscend

/**
 * Custom validation rule for the status range fields confirms that value
 * provided is a two-element array, does not contain nested arrays, does not
 * contain objects, and its elements are in ascending order.
 *
 * @param {Array} arr - The array to test
 * @returns {undefined} - OK
 * @throws {InvalidRangeSizeError}
 * @throws {InvalidRangeValuesError}
 */
function validateStatusRange(arr) {
  arrayHasTwoElements(arr);
  noNestedArrays(arr);
  valuesAreNumeric(arr);
  arrayValuesAscend(arr);
} // validateStatusRange

/**
 * Deletes all the sample entries related to an aspect. The following are
 * deleted:
 * 1. aspect from subject to aspect mappings
 * 2. aspect-to-subject mapping -> samsto:aspsubmap:aspectname
 * 3. sample entry in samsto:samples (samsto:samples:*|oldaspectname)
 * 4. sample hash samsto:samples:*|oldaspectname
 * @param {Object} aspect - aspect object
 * @param {Object} seq - The sequelize object
 * @returns {Promise} which resolves to the deleted samples.
 */
function removeAspectRelatedSamples(aspect, seq) {
  let samples = [];
  return redisOps.deleteSampleKeys(aspSubMapType, aspect.name)
  .then((_samples) => {
    samples = _samples;

    // get subjects from aspect-to-subject mapping for this aspect
    return redisOps.executeCommand(redisOps.getAspSubjMapMembers(aspect.name));
  })
  .then((subjAbsPaths) => redisOps.executeBatchCmds(
    redisOps.deleteAspectFromSubjectResourceMaps(subjAbsPaths, aspect.name)))
  .then(() => redisOps.deleteKey(aspSubMapType, aspect.name))
  .then(() => {
    const promises = [];

    // publish the samples only if the sequelize object seq is available
    if (seq && samples.length) {
      samples.forEach((sample) => {
        /*
         * publishSample attaches the subject and the aspect by fetching it
         * either from the database or redis. Deleted aspect will not be found
         * when called from the afterDelete and afterUpdate hookes. So, attach
         * the aspect here before publishing the sample.
         */
        if (sample) {
          sample.aspect = aspect;
          promises.push(publishSample(sample, seq.models.Subject, sampleEvent.del,
            seq.models.Aspect));
        }
      });
    }

    return Promise.all(promises);
  });
} // removeAspectRelatedSamples

module.exports = {
  validateStatusRange,
  removeAspectRelatedSamples,
}; // exports
