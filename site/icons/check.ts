import { componentsRegistryService } from "cruzo";
import { AbstractIcon } from "./abstract";

export class CheckIcon extends AbstractIcon {
  static selector = "check-icon";

  getHTML() {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M13 24L4 15 5.41 13.59 13 21.17 26.59 7.59 28 9Z"/>
    </svg>`;
  }
}

componentsRegistryService.define(CheckIcon);
