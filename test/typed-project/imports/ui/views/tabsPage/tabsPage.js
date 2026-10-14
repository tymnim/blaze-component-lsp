import { Template } from "meteor/templating";
import { BlazeComponent, Component } from "meteor/znewsham:blaze-component";

/**
 * @template {import("blaze-component-lsp").Template} T
 * @typedef {{ template: T, data: import("blaze-component-lsp").ContextDataFrom<T>, name: string }} Tab
 */

/** @extends BlazeComponent<{}> */
@Component(Template.tabsPage)
export class TabsPage extends BlazeComponent {
  static HelperMap() {
    return ["tabs", "pickedTemplate"];
  }

  /**
   * @returns {Tab[]}
   */
  tabs() {
    return [
      { name: "tab 1", template: "template1", data: { prop1: 1 } },
      { name: "tab 2", template: "template2", data: { title: "hello" } }
    ];
  }

  /**
   * @returns {import("blaze-component-lsp").Template}
   */
  pickedTemplate() {
    return "template1";
  }
}

BlazeComponent.register(Template.tabsPage, TabsPage);
