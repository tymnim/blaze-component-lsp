import { Template } from "meteor/templating";
import { BlazeComponent } from "meteor/znewsham:blaze-component";

import "./colorPicker.html";

export class ColorPicker extends BlazeComponent {
  constructor(templateInstance) {
    super(templateInstance, { color: "#3599cc" });
  }

  static HelperMap() {
    return [
      "colors",
      "currentColorCSS"
    ];
  }

  static EventMap() {
    return {
      "click .color": "selectColor"
    };
  }

  colors() {
    return Object.values(COLORS);
  }

  currentColorCSS() {
    return "some-css";
  }

  selectColor(e) {
    const color = $(e.currentTarget).data("color");
    this.nonReactiveData().onChange(color);
  }
}

BlazeComponent.register(Template.noteColorPicker, ColorPicker);
