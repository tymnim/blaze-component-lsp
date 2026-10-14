import { Template } from "meteor/templating";
import { BlazeComponent, Component } from "meteor/znewsham:blaze-component";

/**
 * @extends BlazeComponent<{
 *   title: string,
 *   count?: number
 * }>
 */
@Component(Template.inlineCard)
export class InlineCard extends BlazeComponent {
  static HelperMap() {
    return ["titleUpper"];
  }

  titleUpper() {
    return this.reactiveData("title").title.toUpperCase();
  }
}

BlazeComponent.register(Template.inlineCard, InlineCard);
