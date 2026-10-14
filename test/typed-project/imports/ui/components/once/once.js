import { Template } from "meteor/templating";
import { BlazeComponent, Component } from "meteor/znewsham:blaze-component";

/** @extends BlazeComponent<boolean> */
@Component(Template.once)
export class once extends BlazeComponent {
  static HelperMap() {
    return [];
  }
}

BlazeComponent.register(Template.once, once);
