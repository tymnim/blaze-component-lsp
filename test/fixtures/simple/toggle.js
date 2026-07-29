import { Template } from "meteor/templating";
import { BlazeComponent, Component } from "meteor/znewsham:blaze-component";

import "./toggle.html";
import "./toggle.scss";

/**
 * @typedef {Object} ContextData
 * @prop {string}      html - HTML string
 * @prop {string}      text
 * @prop {string}      icon   - HTML String
 * @prop {string}      target - used in generating id
 * @prop {boolean}     checked
 * @prop {boolean?}    isDisabled
 * @prop {function(Event, TemplateInstance, boolean):void} onchange
 */

/** @extends BlazeComponent<ContextData> */
@Component(Template.toggleButton)
export class toggleButton extends BlazeComponent {
  constructor(templateInstance) {
    super(templateInstance, {});
  }

  static HelperMap() {
    return [
      "isChecked"
    ];
  }

  static EventMap() {
    return {
      "click .toggle-button": "onchange"
    };
  }

  init() {
    this.checked = new ReactiveVar(false);
    this.dataChanged("checked", ({ checked }) => {
      if (checked === undefined) return;
      this.checked.set(checked);
    });
  }

  isChecked() {
    return this.checked.get() ? "checked" : "unchecked";
  }

  onchange(e, templInstance) {
    e.stopPropagation();
    const chkd = !this.checked.get();
    const { onchange } = this.nonReactiveData();
    onchange(e, templInstance, chkd);
  }
}
