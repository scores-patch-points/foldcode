import { Schema } from "effect"
import { Ipc } from "../sdk"

/**
 * Turns on remote access and keeps this machine's display awake while another device uses it. The window asks the
 * local server for its remote address and pairing codes through its own `ServerRef`; remote access, which changes
 * the background service's settings through the CLI, and the display sleep blocker need the main process.
 */
export const Pairing = Ipc.define({
  id: "pairing",
  methods: {
    /** Whether remote access is on: the background service serves an OpenTunnel address. */
    remote: { output: Schema.Boolean },
    /**
     * Turns remote access on or off, then starts the background service again. Turning it on the first time creates
     * the tunnel, which can take a minute.
     */
    setRemote: { input: Schema.Boolean },
    /** Whether the open link is on: one reusable link that signs in any browser that opens it. */
    link: { output: Schema.Boolean },
    /**
     * Turns the open link on or off, then starts the background service again. Turning it on also turns remote access
     * on, which the first time creates the tunnel and can take a minute.
     */
    setLink: { input: Schema.Boolean },
    /** The open link, once the tunnel serves it. Only meaningful while the link is on. */
    linkURL: { output: Schema.String },
    /** Whether main holds the display sleep blocker. */
    screenActive: { output: Schema.Boolean },
    /** Holds or releases the display sleep blocker, and remembers the choice. */
    setScreenActive: { input: Schema.Boolean },
  },
})
