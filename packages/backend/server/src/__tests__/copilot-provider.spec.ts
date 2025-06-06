import type { ExecutionContext, TestFn } from 'ava';
import ava from 'ava';
import { z } from 'zod';

import { ServerFeature, ServerService } from '../core';
import { AuthService } from '../core/auth';
import { QuotaModule } from '../core/quota';
import { CopilotModule } from '../plugins/copilot';
import { prompts, PromptService } from '../plugins/copilot/prompt';
import { CopilotProviderFactory } from '../plugins/copilot/providers';
import {
  CopilotChatTextExecutor,
  CopilotWorkflowService,
  GraphExecutorState,
} from '../plugins/copilot/workflow';
import {
  CopilotChatImageExecutor,
  CopilotCheckHtmlExecutor,
  CopilotCheckJsonExecutor,
} from '../plugins/copilot/workflow/executor';
import { createTestingModule, TestingModule } from './utils';
import { TestAssets } from './utils/copilot';

type Tester = {
  auth: AuthService;
  module: TestingModule;
  prompt: PromptService;
  factory: CopilotProviderFactory;
  workflow: CopilotWorkflowService;
  executors: {
    image: CopilotChatImageExecutor;
    text: CopilotChatTextExecutor;
    html: CopilotCheckHtmlExecutor;
    json: CopilotCheckJsonExecutor;
  };
};
const test = ava as TestFn<Tester>;

let isCopilotConfigured = false;
const runIfCopilotConfigured = test.macro(
  async (
    t,
    callback: (t: ExecutionContext<Tester>) => Promise<void> | void
  ) => {
    if (isCopilotConfigured) {
      await callback(t);
    } else {
      t.log('Skip test because copilot is not configured');
      t.pass();
    }
  }
);

test.serial.before(async t => {
  const module = await createTestingModule({
    imports: [QuotaModule, CopilotModule],
  });

  const service = module.get(ServerService);
  isCopilotConfigured = service.features.includes(ServerFeature.Copilot);

  const auth = module.get(AuthService);
  const prompt = module.get(PromptService);
  const factory = module.get(CopilotProviderFactory);
  const workflow = module.get(CopilotWorkflowService);

  t.context.module = module;
  t.context.auth = auth;
  t.context.prompt = prompt;
  t.context.factory = factory;
  t.context.workflow = workflow;
  t.context.executors = {
    image: module.get(CopilotChatImageExecutor),
    text: module.get(CopilotChatTextExecutor),
    html: module.get(CopilotCheckHtmlExecutor),
    json: module.get(CopilotCheckJsonExecutor),
  };
});

test.serial.before(async t => {
  const { prompt, executors } = t.context;

  executors.image.register();
  executors.text.register();
  executors.html.register();
  executors.json.register();

  for (const name of await prompt.listNames()) {
    await prompt.delete(name);
  }

  for (const p of prompts) {
    await prompt.set(p.name, p.model, p.messages, p.config);
  }
});

test.after(async t => {
  await t.context.module.close();
});

const assertNotWrappedInCodeBlock = (
  t: ExecutionContext<Tester>,
  result: string
) => {
  t.assert(
    !result.replaceAll('\n', '').trim().startsWith('```') &&
      !result.replaceAll('\n', '').trim().endsWith('```'),
    'should not wrap in code block'
  );
};

const citationChecker = (
  t: ExecutionContext<Tester>,
  citations: { citationNumber: string; citationJson: string }[]
) => {
  t.assert(citations.length > 0, 'should have citation');
  for (const { citationJson } of citations) {
    t.notThrows(() => {
      JSON.parse(citationJson);
    }, `should be valid json: ${citationJson}`);
  }
};

type CitationChecker = typeof citationChecker;

const assertCitation = (
  t: ExecutionContext<Tester>,
  result: string,
  citationCondition: CitationChecker = citationChecker
) => {
  const regex = /\[\^(\d+)\]:\s*({.*})/g;
  const citations = [];
  let match;
  while ((match = regex.exec(result)) !== null) {
    const citationNumber = match[1];
    const citationJson = match[2];
    citations.push({ citationNumber, citationJson });
  }
  citationCondition(t, citations);
};

const checkMDList = (text: string) => {
  const lines = text.split('\n');
  const listItemRegex = /^( {2})*(-|\u2010-\u2015|\*|\+)? .+$/;
  let prevIndent = null;

  for (const line of lines) {
    if (line.trim() === '') continue;
    if (!listItemRegex.test(line)) {
      return false;
    }

    const currentIndent = line.match(/^( *)/)?.[0].length!;
    if (Number.isNaN(currentIndent) || currentIndent % 2 !== 0) {
      return false;
    }

    if (prevIndent !== null && currentIndent > 0) {
      const indentDiff = currentIndent - prevIndent;
      // allow 1 level of indentation difference
      if (indentDiff > 2) {
        return false;
      }
    }

    if (line.trim().startsWith('-')) {
      prevIndent = currentIndent;
    }
  }

  return true;
};

const checkUrl = (url: string) => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

const retry = async (
  action: string,
  t: ExecutionContext<Tester>,
  callback: (t: ExecutionContext<Tester>) => void
) => {
  let i = 3;
  while (i--) {
    const ret = await t.try(callback);
    if (ret.passed) {
      return ret.commit();
    } else {
      ret.discard();
      t.log(ret.errors.map(e => e.message).join('\n'));
      t.log(`retrying ${action} ${3 - i}/3 ...`);
    }
  }
  t.fail(`failed to run ${action}`);
};

// ==================== utils ====================

test('should validate markdown list', t => {
  t.true(
    checkMDList(`
- item 1
- item 2
`)
  );
  t.true(
    checkMDList(`
- item 1
  - item 1.1
- item 2
`)
  );
  t.true(
    checkMDList(`
- item 1
  - item 1.1
    - item 1.1.1
- item 2
`)
  );
  t.true(
    checkMDList(`
- item 1
  - item 1.1
    - item 1.1.1
    - item 1.1.2
- item 2
`)
  );
  t.true(
    checkMDList(`
- item 1
  - item 1.1
    - item 1.1.1
- item 1.2
`)
  );
  t.false(
    checkMDList(`
- item 1
  - item 1.1
      - item 1.1.1.1
`)
  );
  t.true(
    checkMDList(`
- item 1
  - item 1.1
    - item 1.1.1.1
      item 1.1.1.1 line breaks
    - item 1.1.1.2
`),
    'should allow line breaks'
  );
});

// ==================== action ====================

const actions = [
  {
    name: 'Should not have citation',
    promptName: ['Chat With AFFiNE AI'],
    messages: [
      {
        role: 'user' as const,
        content: 'what is ssot',
        params: {
          files: [
            {
              blobId: 'euclidean_distance',
              fileName: 'euclidean_distance.rs',
              fileType: 'text/rust',
              fileContent: TestAssets.Code,
            },
          ],
        },
      },
    ],
    verifier: (t: ExecutionContext<Tester>, result: string) => {
      assertNotWrappedInCodeBlock(t, result);
      assertCitation(t, result, (t, c) => {
        t.assert(c.length === 0, 'should not have citation');
      });
    },
    type: 'text' as const,
  },
  {
    name: 'Should have citation',
    promptName: ['Chat With AFFiNE AI'],
    messages: [
      {
        role: 'user' as const,
        content: 'what is ssot',
        params: {
          files: [
            {
              blobId: 'SSOT',
              fileName: 'Single source of truth - Wikipedia',
              fileType: 'text/markdown',
              fileContent: TestAssets.SSOT,
            },
          ],
        },
      },
    ],
    verifier: (t: ExecutionContext<Tester>, result: string) => {
      assertNotWrappedInCodeBlock(t, result);
      assertCitation(t, result);
    },
    type: 'text' as const,
  },
  {
    promptName: ['Transcript audio'],
    messages: [
      {
        role: 'user' as const,
        content: '',
        attachments: [
          'https://cdn.affine.pro/copilot-test/MP9qDGuYgnY+ILoEAmHpp3h9Npuw2403EAYMEA.mp3',
        ],
      },
    ],
    verifier: (t: ExecutionContext<Tester>, result: string) => {
      // cleanup json markdown wrap
      const cleaned = result
        .replace(/```[\w\s]+\n/g, '')
        .replace(/\n```/g, '')
        .trim();
      t.notThrows(() => {
        z.object({
          a: z.string(),
          s: z.number(),
          e: z.number(),
          t: z.string(),
        })
          .array()
          .parse(JSON.parse(cleaned));
      });
    },
    type: 'text' as const,
  },
  {
    promptName: [
      'Summary',
      'Summary as title',
      'Explain this',
      'Write an article about this',
      'Write a twitter about this',
      'Write a poem about this',
      'Write a blog post about this',
      'Write outline',
      'Change tone to',
      'Improve writing for it',
      'Improve grammar for it',
      'Fix spelling for it',
      'Create headings',
      'Make it longer',
      'Make it shorter',
      'Continue writing',
      'Chat With AFFiNE AI',
      'Search With AFFiNE AI',
    ],
    messages: [{ role: 'user' as const, content: TestAssets.SSOT }],
    verifier: (t: ExecutionContext<Tester>, result: string) => {
      assertNotWrappedInCodeBlock(t, result);
      t.assert(
        result.toLowerCase().includes('single source of truth'),
        'should include original keyword'
      );
    },
    type: 'text' as const,
  },
  {
    promptName: ['Brainstorm ideas about this', 'Brainstorm mindmap'],
    messages: [{ role: 'user' as const, content: TestAssets.SSOT }],
    verifier: (t: ExecutionContext<Tester>, result: string) => {
      assertNotWrappedInCodeBlock(t, result);
      t.assert(checkMDList(result), 'should be a markdown list');
    },
    type: 'text' as const,
  },
  {
    promptName: 'Expand mind map',
    messages: [{ role: 'user' as const, content: '- Single source of truth' }],
    verifier: (t: ExecutionContext<Tester>, result: string) => {
      assertNotWrappedInCodeBlock(t, result);
      t.assert(checkMDList(result), 'should be a markdown list');
    },
    type: 'text' as const,
  },
  {
    promptName: 'Find action items from it',
    messages: [{ role: 'user' as const, content: TestAssets.TODO }],
    verifier: (t: ExecutionContext<Tester>, result: string) => {
      assertNotWrappedInCodeBlock(t, result);
      t.assert(checkMDList(result), 'should be a markdown list');
    },
    type: 'text' as const,
  },
  {
    promptName: ['Explain this code', 'Check code error'],
    messages: [{ role: 'user' as const, content: TestAssets.Code }],
    verifier: (t: ExecutionContext<Tester>, result: string) => {
      assertNotWrappedInCodeBlock(t, result);
      t.assert(
        result.toLowerCase().includes('distance'),
        'explain code result should include keyword'
      );
    },
    type: 'text' as const,
  },
  {
    promptName: 'Translate to',
    messages: [
      {
        role: 'user' as const,
        content: TestAssets.SSOT,
        params: { language: 'Simplified Chinese' },
      },
    ],
    verifier: (t: ExecutionContext<Tester>, result: string) => {
      assertNotWrappedInCodeBlock(t, result);
      t.assert(
        result.toLowerCase().includes('单一事实来源'),
        'explain code result should include keyword'
      );
    },
    type: 'text' as const,
  },
  {
    promptName: ['Generate a caption', 'Explain this image'],
    messages: [
      {
        role: 'user' as const,
        content: '',
        attachments: [
          'https://cdn.affine.pro/copilot-test/Qgqy9qZT3VGIEuMIotJYoCCH.jpg',
        ],
      },
    ],
    verifier: (t: ExecutionContext<Tester>, result: string) => {
      assertNotWrappedInCodeBlock(t, result);
      const content = result.toLowerCase();
      t.assert(
        content.includes('classroom') ||
          content.includes('school') ||
          content.includes('sky'),
        'explain code result should include keyword'
      );
    },
    type: 'text' as const,
  },
  {
    promptName: [
      'debug:action:fal-face-to-sticker',
      'debug:action:fal-remove-bg',
      'debug:action:fal-sd15',
      'debug:action:fal-upscaler',
    ],
    messages: [
      {
        role: 'user' as const,
        content: '',
        attachments: [
          'https://cdn.affine.pro/copilot-test/Zkas098lkjdf-908231.jpg',
        ],
      },
    ],
    verifier: (t: ExecutionContext<Tester>, link: string) => {
      t.truthy(checkUrl(link), 'should be a valid url');
    },
    type: 'image' as const,
  },
  {
    promptName: ['debug:action:dalle3'],
    messages: [
      {
        role: 'user' as const,
        content: 'Panda',
      },
    ],
    verifier: (t: ExecutionContext<Tester>, link: string) => {
      t.truthy(checkUrl(link), 'should be a valid url');
    },
    type: 'image' as const,
  },
];

for (const { name, promptName, messages, verifier, type } of actions) {
  const prompts = Array.isArray(promptName) ? promptName : [promptName];
  for (const promptName of prompts) {
    test(
      `should be able to run action: ${promptName}${name ? ` - ${name}` : ''}`,
      runIfCopilotConfigured,
      async t => {
        const { factory, prompt: promptService } = t.context;
        const prompt = (await promptService.get(promptName))!;
        t.truthy(prompt, 'should have prompt');
        const provider = (await factory.getProviderByModel(prompt.model))!;
        t.truthy(provider, 'should have provider');
        await retry(`action: ${promptName}`, t, async t => {
          if (type === 'text' && 'generateText' in provider) {
            const result = await provider.generateText(
              [
                ...prompt.finish(
                  messages.reduce(
                    // @ts-expect-error
                    (acc, m) => Object.assign(acc, m.params),
                    {}
                  )
                ),
                ...messages,
              ],
              prompt.model
            );
            t.truthy(result, 'should return result');
            verifier?.(t, result);
          } else if (type === 'image' && 'generateImages' in provider) {
            const result = await provider.generateImages(
              [
                ...prompt.finish(
                  messages.reduce(
                    // @ts-expect-error
                    (acc, m) => Object.assign(acc, m.params),
                    {}
                  )
                ),
                ...messages,
              ],
              prompt.model
            );
            t.truthy(result.length, 'should return result');
            for (const r of result) {
              verifier?.(t, r);
            }
          } else {
            t.fail('unsupported provider type');
          }
        });
      }
    );
  }
}

// ==================== workflow ====================

const workflows = [
  {
    name: 'brainstorm',
    content: 'apple company',
    verifier: (t: ExecutionContext, result: string) => {
      t.assert(checkMDList(result), 'should be a markdown list');
    },
  },
  {
    name: 'presentation',
    content: 'apple company',
    verifier: (t: ExecutionContext, result: string) => {
      for (const l of result.split('\n')) {
        t.notThrows(() => {
          JSON.parse(l.trim());
        }, 'should be valid json');
      }
    },
  },
];

for (const { name, content, verifier } of workflows) {
  test(
    `should be able to run workflow: ${name}`,
    runIfCopilotConfigured,
    async t => {
      const { workflow } = t.context;

      await retry(`workflow: ${name}`, t, async t => {
        let result = '';
        for await (const ret of workflow.runGraph({ content }, name)) {
          if (ret.status === GraphExecutorState.EnterNode) {
            t.log('enter node:', ret.node.name);
          } else if (ret.status === GraphExecutorState.ExitNode) {
            t.log('exit node:', ret.node.name);
          } else if (ret.status === GraphExecutorState.EmitAttachment) {
            t.log('stream attachment:', ret);
          } else {
            result += ret.content;
          }
        }
        t.truthy(result, 'should return result');
        verifier?.(t, result);
      });
    }
  );
}
