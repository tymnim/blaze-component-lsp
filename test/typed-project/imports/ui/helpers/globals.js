import { Blaze } from "meteor/blaze";

Blaze.registerHelper(
  "upper",
  /**
   * @param {string} value
   * @returns {string}
   */
  function (value) {
    return value.toUpperCase();
  }
);
