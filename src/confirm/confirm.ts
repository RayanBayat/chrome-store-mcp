/**
 * Asks a person before a write action that affects users (publish, cancel, roll back, change the rollout).
 *
 * Why: an AI model can be tricked (for example by text inside a store review) into calling a tool. A confirmation
 * that only a person can answer means a tricked model still cannot publish anything.
 *
 * Two ways to ask, chosen by CWS_CONFIRM (see src/config.ts):
 *   - a desktop dialog (kdialog on KDE, zenity on GNOME and others), shown outside the AI client entirely;
 *   - an MCP "elicitation": the MCP client shows the question to the person and returns their answer.
 * If neither is available, the action is refused. CWS_CONFIRM=none turns confirmation off (only for trusted automation).
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { ConfirmMode } from '../config.ts';
import { DeclinedError, SetupError } from '../errors.ts';

export const DIALOG_TIMEOUT_MS = 120_000;

export interface ConfirmRequest {
  /** Short label for the action button, e.g. "Publish". */
  action: string;
  /** One line per fact the person should check. Only validated values go in here. */
  details: string[];
}

/** Resolves when the person said yes; throws DeclinedError or SetupError otherwise. */
export type Confirm = (request: ConfirmRequest) => Promise<void>;

/** Asks through the MCP client. Resolves true/false, or 'unsupported' when the client cannot ask. */
export type Elicit = (message: string) => Promise<boolean | 'unsupported'>;

export interface ConfirmDeps {
  mode: ConfirmMode;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  elicit: Elicit;
  /** Runs a dialog program and resolves its exit code (0 means yes). Rejects or returns non-zero otherwise. */
  runDialog?: (program: string, args: string[]) => Promise<number>;
  /** True when a program is on the PATH. */
  hasProgram?: (program: string) => Promise<boolean>;
}

/**
 * Makes text safe for a dialog: keeps printable characters only, removes `<`, `>` and `&` (Qt and GTK would treat
 * them as markup), and caps the length, so the person sees exactly what will happen.
 */
export function cleanForDialog(text: string): string {
  return text
    .replace(/[^\P{C}\n]/gu, '')
    .replace(/[<>&]/g, '')
    .slice(0, 300);
}

export function dialogText(request: ConfirmRequest): string {
  return ['An AI assistant asks to change your Chrome Web Store item:', '', ...request.details.map(cleanForDialog), '', 'Allow it?'].join(
    '\n',
  );
}

/** The command line for each supported dialog program. Values go in as separate arguments: no shell is involved. */
export function dialogCommand(program: 'kdialog' | 'zenity', request: ConfirmRequest): string[] {
  const text = dialogText(request);
  const action = cleanForDialog(request.action);
  if (program === 'kdialog') {
    return ['--title', 'Chrome Web Store', '--warningyesno', text, '--yes-label', action, '--no-label', 'Cancel'];
  }
  return [
    '--question',
    '--title=Chrome Web Store',
    `--text=${text}`,
    '--no-markup',
    `--ok-label=${action}`,
    '--cancel-label=Cancel',
    '--default-cancel',
    '--width=520',
  ];
}

async function defaultHasProgram(program: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      await access(join(dir, program), constants.X_OK);
      return true;
    } catch {
      // not in this folder
    }
  }
  return false;
}

/** Runs a dialog program; resolves its exit code. No answer within `timeoutMs` closes it and counts as "no". */
export function runDialog(program: string, args: string[], timeoutMs: number = DIALOG_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(1);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

export function createConfirm(deps: ConfirmDeps): Confirm {
  const hasProgram = deps.hasProgram ?? ((program: string) => defaultHasProgram(program, deps.env));
  const runDialogProgram = deps.runDialog ?? runDialog;

  /** kdialog or zenity, if this is a Linux desktop session that has one. */
  async function findDialog(): Promise<'kdialog' | 'zenity' | null> {
    const hasDesktop = deps.platform === 'linux' && Boolean(deps.env.DISPLAY || deps.env.WAYLAND_DISPLAY);
    if (!hasDesktop) return null;
    if (await hasProgram('kdialog')) return 'kdialog';
    if (await hasProgram('zenity')) return 'zenity';
    return null;
  }

  async function askWithDialog(program: 'kdialog' | 'zenity', request: ConfirmRequest): Promise<void> {
    const code = await runDialogProgram(program, dialogCommand(program, request));
    if (code !== 0) throw new DeclinedError('Declined in the confirmation dialog (or no answer within 2 minutes). Nothing was changed.');
  }

  async function askWithElicitation(request: ConfirmRequest): Promise<'asked' | 'unsupported'> {
    const answer = await deps.elicit(dialogText(request));
    if (answer === 'unsupported') return 'unsupported';
    if (!answer) throw new DeclinedError('Declined in the confirmation prompt. Nothing was changed.');
    return 'asked';
  }

  return async (request) => {
    switch (deps.mode) {
      case 'none':
        return;
      case 'dialog': {
        const program = await findDialog();
        if (!program) throw new SetupError('CWS_CONFIRM=dialog, but no desktop dialog (kdialog or zenity) is available.');
        await askWithDialog(program, request);
        return;
      }
      case 'elicit': {
        if ((await askWithElicitation(request)) === 'unsupported') {
          throw new SetupError('CWS_CONFIRM=elicit, but this MCP client cannot show confirmation prompts.');
        }
        return;
      }
      case 'auto': {
        const program = await findDialog();
        if (program) {
          await askWithDialog(program, request);
          return;
        }
        if ((await askWithElicitation(request)) === 'unsupported') {
          throw new SetupError(
            'There is no way to ask you for confirmation: install kdialog or zenity, use an MCP client that supports elicitation, or set CWS_CONFIRM=none if you accept the risk.',
          );
        }
        return;
      }
    }
  };
}
