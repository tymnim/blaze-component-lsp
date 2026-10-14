import { Template } from "meteor/templating";
import { BlazeComponent, Component } from "meteor/znewsham:blaze-component";

import "./toggle.html";

/**
 * @typedef {Object} ContextData
 * @prop {string} text
 * @prop {boolean} checked
 * @prop {boolean} [isDisabled]
 */

/** @extends BlazeComponent<ContextData> */
@Component(Template.toggleButton)
export class toggleButton extends BlazeComponent {
  constructor(templateInstance) {
    super(templateInstance, {});
  }

  static HelperMap() {
    return ["isChecked", "label"];
  }

  /**
   * @returns {string}
   */
  isChecked() {
    return this.reactiveData("checked").checked ? "checked" : "unchecked";
  }

  /**
   * @param {number} n
   * @returns {string}
   */
  label(n) {
    return `${n}`;
  }
}

BlazeComponent.register(Template.toggleButton, toggleButton);
