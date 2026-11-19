import { createSignal } from "solid-js"
import { useLarpcode } from "../context/larpcode"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogLarpcodeSettings } from "./dialog-larpcode-settings"

/** Cells reserved at the right end of the horizontal tab strip. */
export const LARPCODE_BUTTON_WIDTH = 4

export function LarpcodeButton() {
  const larpcode = useLarpcode()
  const dialog = useDialog()
  const theme = useTheme()
  const [hovered, setHovered] = createSignal(false)
  const warning = () => larpcode.missing() > 0

  return (
    <text
      width={LARPCODE_BUTTON_WIDTH}
      flexShrink={0}
      fg={warning() ? theme.text.feedback.warning.base : hovered() ? theme.text.base : theme.text.muted}
      bg={hovered() ? theme.background.action.primary.hovered : undefined}
      selectable={false}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseUp={(event) => {
        event.preventDefault()
        event.stopPropagation()
        dialog.replace(() => <DialogLarpcodeSettings />)
      }}
    >
      {warning() ? " ⚙! " : " ⚙  "}
    </text>
  )
}
