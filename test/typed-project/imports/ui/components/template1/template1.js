import { Template } from "meteor/templating";
import { BlazeComponent, Component } from "meteor/znewsham:blaze-component";

/**
 * @typedef {Object} ContextData
 * @prop {number} prop1
 */

/** @extends BlazeComponent<ContextData> */
@Component(Template.template1)
export class Template1 extends BlazeComponent {
  static HelperMap() {
    return [];
  }
}

BlazeComponent.register(Template.template1, Template1);
