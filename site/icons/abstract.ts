import { AbstractComponent } from "cruzo";

export abstract class AbstractIcon extends AbstractComponent {
  disconnectedCallback() {
    super.disconnectedCallback();
  }

  connectedCallback() {
    this.node.innerHTML = this.getHTML();
  }
}
