import { Template } from "meteor/templating";
import { BlazeComponent, Component } from "meteor/znewsham:blaze-component";

/**
 * @typedef {Object} ContextData
 * @prop {string} title
 */

/** @extends BlazeComponent<ContextData> */
@Component(Template.template2)
export class Template2 extends BlazeComponent {
  static HelperMap() {
    return [];
  }
}

BlazeComponent.register(Template.template2, Template2);
