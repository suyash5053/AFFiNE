import { Injectable } from '@nestjs/common';
import { AiJobStatus, AiJobType } from '@prisma/client';
import { ZodType } from 'zod';

import {
  CopilotPromptNotFound,
  CopilotTranscriptionJobExists,
  CopilotTranscriptionJobNotFound,
  EventBus,
  type FileUpload,
  JobQueue,
  NoCopilotProviderAvailable,
  OnEvent,
  OnJob,
} from '../../../base';
import { Models } from '../../../models';
import { PromptService } from '../prompt';
import {
  CopilotCapability,
  CopilotProviderFactory,
  CopilotTextProvider,
  PromptMessage,
} from '../providers';
import { CopilotStorage } from '../storage';
import {
  AudioBlobInfos,
  TranscriptionPayload,
  TranscriptionResponseSchema,
  TranscriptPayloadSchema,
} from './types';
import { readStream } from './utils';

export type TranscriptionJob = {
  id: string;
  status: AiJobStatus;
  infos?: AudioBlobInfos;
  transcription?: TranscriptionPayload;
};

@Injectable()
export class CopilotTranscriptionService {
  constructor(
    private readonly event: EventBus,
    private readonly models: Models,
    private readonly job: JobQueue,
    private readonly storage: CopilotStorage,
    private readonly prompt: PromptService,
    private readonly providerFactory: CopilotProviderFactory
  ) {}

  async submitTranscriptionJob(
    userId: string,
    workspaceId: string,
    blobId: string,
    blobs: FileUpload[]
  ): Promise<TranscriptionJob> {
    if (await this.models.copilotJob.has(userId, workspaceId, blobId)) {
      throw new CopilotTranscriptionJobExists();
    }

    const { id: jobId } = await this.models.copilotJob.create({
      workspaceId,
      blobId,
      createdBy: userId,
      type: AiJobType.transcription,
    });

    const infos: AudioBlobInfos = [];
    for (const blob of blobs) {
      const buffer = await readStream(blob.createReadStream());
      const url = await this.storage.put(userId, workspaceId, blobId, buffer);
      infos.push({ url, mimeType: blob.mimetype });
    }

    return await this.executeTranscriptionJob(jobId, infos);
  }

  async executeTranscriptionJob(
    jobId: string,
    infos: AudioBlobInfos
  ): Promise<TranscriptionJob> {
    const status = AiJobStatus.running;
    const success = await this.models.copilotJob.update(jobId, {
      status,
      payload: { infos },
    });

    if (!success) {
      throw new CopilotTranscriptionJobNotFound();
    }

    await this.job.add('copilot.transcript.submit', {
      jobId,
      infos,
    });

    return { id: jobId, status };
  }

  async claimTranscriptionJob(
    userId: string,
    jobId: string
  ): Promise<TranscriptionJob | null> {
    const status = await this.models.copilotJob.claim(jobId, userId);
    if (status === AiJobStatus.claimed) {
      const transcription = await this.models.copilotJob.getPayload(
        jobId,
        TranscriptPayloadSchema
      );
      return { id: jobId, transcription, status };
    }
    return null;
  }

  async queryTranscriptionJob(
    userId: string,
    workspaceId: string,
    jobId?: string,
    blobId?: string
  ) {
    const job = await this.models.copilotJob.getWithUser(
      userId,
      workspaceId,
      jobId,
      blobId,
      AiJobType.transcription
    );

    if (!job) {
      return null;
    }

    const ret: TranscriptionJob = { id: job.id, status: job.status };

    const payload = TranscriptPayloadSchema.safeParse(job.payload);
    if (payload.success) {
      let { url, mimeType, infos } = payload.data;
      infos = infos || [];
      if (url && mimeType) {
        infos.push({ url, mimeType });
      }

      ret.infos = this.mergeInfos(infos, url, mimeType);
      if (job.status === AiJobStatus.claimed) {
        ret.transcription = payload.data;
      }
    }

    return ret;
  }

  private async getProvider(model: string): Promise<CopilotTextProvider> {
    let provider = await this.providerFactory.getProviderByCapability(
      CopilotCapability.TextToText,
      { model }
    );

    if (!provider) {
      throw new NoCopilotProviderAvailable();
    }

    return provider;
  }

  private async chatWithPrompt(
    promptName: string,
    message: Partial<PromptMessage>,
    schema?: ZodType<any>
  ): Promise<string> {
    const prompt = await this.prompt.get(promptName);
    if (!prompt) {
      throw new CopilotPromptNotFound({ name: promptName });
    }

    const provider = await this.getProvider(prompt.model);
    return provider.generateText(
      [...prompt.finish({ schema }), { role: 'user', content: '', ...message }],
      prompt.model,
      Object.assign({}, prompt.config)
    );
  }

  // TODO(@darkskygit): remove after old server down
  private mergeInfos(
    infos?: AudioBlobInfos | null,
    url?: string | null,
    mimeType?: string | null
  ) {
    if (url && mimeType) {
      if (infos) {
        infos.push({ url, mimeType });
      } else {
        infos = [{ url, mimeType }];
      }
    }
    return infos || [];
  }

  private convertTime(time: number, offset = 0) {
    time = time + offset;
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    const hours = Math.floor(minutes / 60);
    const minutesStr = String(minutes % 60).padStart(2, '0');
    const secondsStr = String(seconds).padStart(2, '0');
    const hoursStr = String(hours).padStart(2, '0');
    return `${hoursStr}:${minutesStr}:${secondsStr}`;
  }

  @OnJob('copilot.transcript.submit')
  async transcriptAudio({
    jobId,
    infos,
    // @deprecated
    url,
    mimeType,
  }: Jobs['copilot.transcript.submit']) {
    try {
      const blobInfos = this.mergeInfos(infos, url, mimeType);
      const transcriptions = [];
      for (const [idx, { url, mimeType }] of blobInfos.entries()) {
        const result = await this.chatWithPrompt(
          'Transcript audio',
          {
            attachments: [url],
            params: { mimetype: mimeType },
          },
          TranscriptionResponseSchema
        );

        const offset = idx * 10 * 60;
        const transcription = TranscriptionResponseSchema.parse(
          JSON.parse(result)
        ).map(t => ({
          speaker: t.a,
          start: this.convertTime(t.s, offset),
          end: this.convertTime(t.e, offset),
          transcription: t.t,
        }));
        transcriptions.push(transcription);
      }

      await this.models.copilotJob.update(jobId, {
        payload: { transcription: transcriptions.flat() },
      });

      await this.job.add('copilot.transcript.summary.submit', {
        jobId,
      });
      return;
    } catch (error: any) {
      // record failed status and passthrough error
      this.event.emit('workspace.file.transcript.failed', {
        jobId,
      });
      throw error;
    }
  }

  @OnJob('copilot.transcript.summary.submit')
  async transcriptSummary({
    jobId,
  }: Jobs['copilot.transcript.summary.submit']) {
    try {
      const payload = await this.models.copilotJob.getPayload(
        jobId,
        TranscriptPayloadSchema
      );
      if (payload.transcription) {
        const content = payload.transcription
          .map(t => t.transcription.trim())
          .join('\n')
          .trim();

        if (content.length) {
          payload.summary = await this.chatWithPrompt('Summary', {
            content,
          });
          await this.models.copilotJob.update(jobId, {
            payload,
          });

          await this.job.add('copilot.transcript.title.submit', {
            jobId,
          });
          return;
        }
      }
      this.event.emit('workspace.file.transcript.failed', {
        jobId,
      });
    } catch (error: any) {
      // record failed status and passthrough error
      this.event.emit('workspace.file.transcript.failed', {
        jobId,
      });
      throw error;
    }
  }

  @OnJob('copilot.transcript.title.submit')
  async transcriptTitle({ jobId }: Jobs['copilot.transcript.title.submit']) {
    try {
      const payload = await this.models.copilotJob.getPayload(
        jobId,
        TranscriptPayloadSchema
      );
      if (payload.transcription && payload.summary) {
        const content = payload.transcription
          .map(t => t.transcription.trim())
          .join('\n')
          .trim();

        if (content.length) {
          payload.title = await this.chatWithPrompt('Summary as title', {
            content,
          });
          await this.models.copilotJob.update(jobId, {
            payload,
          });
          this.event.emit('workspace.file.transcript.finished', {
            jobId,
          });
          return;
        }
      }
      this.event.emit('workspace.file.transcript.failed', {
        jobId,
      });
    } catch (error: any) {
      // record failed status and passthrough error
      this.event.emit('workspace.file.transcript.failed', {
        jobId,
      });
      throw error;
    }
  }

  @OnEvent('workspace.file.transcript.finished')
  async onFileTranscriptFinish({
    jobId,
  }: Events['workspace.file.transcript.finished']) {
    await this.models.copilotJob.update(jobId, {
      status: AiJobStatus.finished,
    });
  }

  @OnEvent('workspace.file.transcript.failed')
  async onFileTranscriptFailed({
    jobId,
  }: Events['workspace.file.transcript.failed']) {
    await this.models.copilotJob.update(jobId, {
      status: AiJobStatus.failed,
    });
  }
}
