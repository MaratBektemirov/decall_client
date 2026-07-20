export const MESSENGER_OUTGOING = "#e8f5e9";
export const MESSENGER_INCOMING = "#f2f3f5";
export const MESSENGER_OUTGOING_TEXT = "#248a3d";
export const MESSENGER_INCOMING_TEXT = "#333333";

export function messengerBubbleTailSvg(type: "left" | "right", fill: string): string {
  if (type === "left") {
    return `<svg viewBox="0 0 20 14" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path fill-rule="evenodd" fill="${fill}" clip-rule="evenodd" d="M0 13.6716V14H6C13.732 14 20 7.73199 20 0H5.00033C5.00033 2.73829 5.00033 4.10744 4.80939 5.25169C4.24701 8.62183 2.49706 11.5753 0 13.6716Z"/>
  </svg>`;
  }

  return `<svg viewBox="0 0 20 14" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path fill-rule="evenodd" fill="${fill}" clip-rule="evenodd" d="M20 13.6716V14H14C6.26801 14 0 7.73199 0 0H14.9997C14.9997 2.73829 14.9997 4.10744 15.1906 5.25169C15.753 8.62183 17.5029 11.5753 20 13.6716Z"/>
  </svg>`;
}
