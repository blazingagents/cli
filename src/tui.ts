import type { RunAgentTUIOptions } from "@ai-sdk/tui";

export type TuiLoader = () => Promise<{
  runAgentTUI: (options: RunAgentTUIOptions) => Promise<void>;
}>;

interface TuiTerminal {
  isTTY?: boolean;
  pause: () => unknown;
  setRawMode?: (mode: boolean) => unknown;
}

/**
 * Owns the upstream runner lifecycle shared by Chat and Assist, including its
 * pre-stream alternate-screen cleanup requirement.
 */
export async function runTerminalTui({
  loadTui,
  options,
  stdout,
  terminal,
}: {
  loadTui: TuiLoader;
  options: RunAgentTUIOptions;
  stdout: (text: string) => void;
  terminal: TuiTerminal;
}): Promise<void> {
  const { runAgentTUI } = await loadTui();
  try {
    await runAgentTUI(options);
  } catch (error) {
    if (terminal.isTTY) {
      terminal.setRawMode?.(false);
      terminal.pause();
    }
    stdout("\u001B[?25h\u001B[?1049l");
    throw error;
  }
}
