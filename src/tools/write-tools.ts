/**
 * The five write tools. They use the separate write sign-in.
 *
 * Every tool that affects users (publish, cancel, roll back, change the rollout) asks a person first, through
 * `context.confirm`. Uploading only replaces the draft package, which users never see until it is published, so it
 * does not ask.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveItemName, VERSION_PATTERN } from '../store/ids.ts';
import { checkPackageFile } from '../store/client.ts';
import { itemArgs, type ToolContext } from './context.ts';
import { render, runTool } from './result.ts';

const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export function registerWriteTools(server: McpServer, context: ToolContext): void {
  const { client, defaults, confirm } = context;

  server.registerTool(
    'cws_upload',
    {
      title: 'Chrome Web Store: upload a new package',
      description:
        'Write. Uploads a ZIP as the new draft package of an existing item. Users see nothing until it is published. The manifest version must be higher than the last uploaded one. Creating a new item is not possible through the API.',
      inputSchema: {
        ...itemArgs,
        zipPath: z.string().min(1).max(4096).describe('Absolute path to the extension ZIP.'),
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(async () => {
        const name = resolveItemName(args, defaults);
        const file = await checkPackageFile(args.zipPath);
        return render(await client.upload(name, file));
      }, context.notice()),
  );

  server.registerTool(
    'cws_publish',
    {
      title: 'Chrome Web Store: submit for review / publish',
      description:
        'Write, asks the person first. Submits the current draft for review. STAGED_PUBLISH (default) waits after approval until the owner presses Publish; DEFAULT_PUBLISH goes live as soon as it is approved.',
      inputSchema: {
        ...itemArgs,
        publishType: z.enum(['STAGED_PUBLISH', 'DEFAULT_PUBLISH']).default('STAGED_PUBLISH'),
        deployPercentage: z.number().int().min(0).max(100).optional().describe('Initial rollout percentage.'),
        skipReview: z.boolean().default(false).describe('Ask Google to skip review (only some updates qualify).'),
        blockOnWarnings: z.boolean().default(true).describe('Fail instead of submitting when Google reports warnings.'),
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(async () => {
        const name = resolveItemName(args, defaults);
        await confirm({
          action: 'Submit',
          details: [
            `Item: ${name}`,
            args.publishType === 'STAGED_PUBLISH'
              ? 'Submit for review. After approval it waits until you press Publish in the dashboard.'
              : 'Submit for review. It goes LIVE AUTOMATICALLY as soon as Google approves it.',
            ...(args.deployPercentage === undefined ? [] : [`Initial rollout: ${String(args.deployPercentage)}% of users`]),
            ...(args.skipReview ? ['Ask Google to SKIP REVIEW.'] : []),
          ],
        });
        const request: Record<string, unknown> = {
          publishType: args.publishType,
          skipReview: args.skipReview,
          blockOnWarnings: args.blockOnWarnings,
        };
        if (args.deployPercentage !== undefined) request.deployInfos = [{ deployPercentage: args.deployPercentage }];
        return render(await client.publish(name, request));
      }, context.notice()),
  );

  server.registerTool(
    'cws_cancel_submission',
    {
      title: 'Chrome Web Store: cancel the pending submission',
      description: 'Write, asks the person first. Cancels the submission that is waiting for review.',
      inputSchema: itemArgs,
      annotations: WRITE,
    },
    (args) =>
      runTool(async () => {
        const name = resolveItemName(args, defaults);
        await confirm({ action: 'Cancel submission', details: [`Item: ${name}`, 'Cancel the submission that is waiting for review.'] });
        return render(await client.cancelSubmission(name));
      }, context.notice()),
  );

  server.registerTool(
    'cws_rollback',
    {
      title: 'Chrome Web Store: roll back to an earlier version',
      description:
        'Write, asks the person first (unless validateOnly). Publishes an earlier package to all users under a new, higher version number. Use validateOnly to check the request without changing anything.',
      inputSchema: {
        ...itemArgs,
        targetCrxVersion: z.string().regex(VERSION_PATTERN).describe('The earlier published version to go back to, e.g. 1.2.0.'),
        newVersion: z.string().regex(VERSION_PATTERN).describe('The new version number it gets; must be higher than the current one.'),
        rollbackReason: z.string().min(1).max(500).describe('Why. Google keeps this for auditing and shows it in the dashboard.'),
        validateOnly: z.boolean().default(false).describe('Only check the request; change nothing.'),
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(async () => {
        const name = resolveItemName(args, defaults);
        if (!args.validateOnly) {
          await confirm({
            action: 'Roll back',
            details: [
              `Item: ${name}`,
              `Publish version ${args.targetCrxVersion} again to ALL users, as version ${args.newVersion}.`,
              `Reason: ${args.rollbackReason}`,
            ],
          });
        }
        return render(
          await client.rollback(name, {
            targetCrxVersion: args.targetCrxVersion,
            newVersion: args.newVersion,
            rollbackReason: args.rollbackReason,
            validateOnly: args.validateOnly,
          }),
        );
      }, context.notice()),
  );

  server.registerTool(
    'cws_set_deploy_percentage',
    {
      title: 'Chrome Web Store: raise the rollout percentage',
      description:
        'Write, asks the person first. Raises the share of users who get the published version. Only for items with more than 10,000 seven-day active users; the new value must be higher than the current one.',
      inputSchema: {
        ...itemArgs,
        deployPercentage: z.number().int().min(1).max(100).describe('The new rollout percentage.'),
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(async () => {
        const name = resolveItemName(args, defaults);
        await confirm({
          action: 'Raise rollout',
          details: [`Item: ${name}`, `Roll the published version out to ${String(args.deployPercentage)}% of users.`],
        });
        return render(await client.setDeployPercentage(name, args.deployPercentage));
      }, context.notice()),
  );
}
