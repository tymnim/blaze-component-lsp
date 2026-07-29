import { Template } from "meteor/templating";
import { BlazeComponent, Helper, Event, Component } from "meteor/znewsham:blaze-component";

import "./index.html";

@Component(Template.index)
export class Index extends BlazeComponent {
  constructor(templateInstance) {
    super(templateInstance, {});
  }

  @Helper
  performingOfflineDownload() {
    return false;
  }

  @Helper
  text() {
    return "download";
  }

  @Helper
  assignments() {
    return { docs: [], totalCount: 0 };
  }

  @Helper
  allowed(role, option) {
    return true;
  }

  @Helper
  planeModeToggle() {
    return () => {};
  }

  @Event("click .dashboard-section-sort")
  onSort(e) {
    e.preventDefault();
  }

  @Event("click .titleDropdownContainer")
  toggleSection(e) {
    e.preventDefault();
  }
}
