import "cruzo/ui-components/vars.css";
import "cruzo/ui-components/button.css";
import "cruzo/ui-components/button-group.css";
import "cruzo/ui-components/input.css";
import "cruzo/ui-components/textarea.css";
import "cruzo/ui-components/modal.css";
import "cruzo/ui-components/toast.css";
import "cruzo/ui-components/spinner.css";
import "cruzo/ui-components/margin.css";
import "./css/common.css";
import "site/web3-setup";

import { Template, componentsRegistryService, routerService } from "cruzo";
import { ToastComponent } from "cruzo/ui-components/toast";

routerService.setHashMode(true);

import "site/urls";

function initApp() {
  componentsRegistryService.define(ToastComponent);
  Template.setAppVariables({});
  componentsRegistryService.initApp();
  routerService.update();
}

initApp();
