import { Blaze } from "meteor/blaze";

Blaze.registerHelper(
  "upper",
  /**
   * Uppercase a string value.
   * @param {string} value
   * @returns {string}
   */
  function (value) {
    return value.toUpperCase();
  }
);

Blaze.registerHelper(
  "queryParamsWith",
  /**
   * Reactively makes query params with {key}={value} with respect to other query params and page changes
   * @param {string} key
   * @param {string} value
   * @returns {string}
   */
  function makeQueryParams(key, value) {
    return `?${key}=${value}`;
  }
);
