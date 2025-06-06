import { ThemeProvider } from '@blocksuite/affine-shared/services';
import { EdgelessToolbarToolMixin } from '@blocksuite/affine-widget-edgeless-toolbar';
import type { GfxToolsFullOptionValue } from '@blocksuite/std/gfx';
import { css, html, LitElement } from 'lit';

import { EdgelessEraserDarkIcon, EdgelessEraserLightIcon } from './icons.js';

export class EdgelessEraserToolButton extends EdgelessToolbarToolMixin(
  LitElement
) {
  static override styles = css`
    :host {
      height: 100%;
      overflow-y: hidden;
    }
    .eraser-button {
      display: flex;
      justify-content: center;
      align-items: flex-end;
      position: relative;
      width: 49px;
      height: 64px;
    }
    #edgeless-eraser-icon {
      transition: transform 0.3s ease-in-out;
      transform: translateY(8px);
    }
    .eraser-button:hover #edgeless-eraser-icon,
    .eraser-button.active #edgeless-eraser-icon {
      transform: translateY(0);
    }
  `;

  override enableActiveBackground = true;

  override type: GfxToolsFullOptionValue['type'] = 'eraser';

  override firstUpdated() {
    this.disposables.add(
      this.edgeless.bindHotKey(
        {
          Escape: () => {
            if (this.edgelessTool.type === 'eraser') {
              // @ts-expect-error FIXME: resolve after gfx tool refactor
              this.setEdgelessTool({ type: 'default' });
            }
          },
        },
        { global: true }
      )
    );
  }

  override render() {
    const type = this.edgelessTool?.type;
    const appTheme = this.edgeless.std.get(ThemeProvider).app$.value;
    const icon =
      appTheme === 'dark' ? EdgelessEraserDarkIcon : EdgelessEraserLightIcon;

    return html`
      <edgeless-toolbar-button
        class="edgeless-eraser-button"
        .tooltip=${html`<affine-tooltip-content-with-shortcut
          data-tip="${'Eraser'}"
          data-shortcut="${'E'}"
        ></affine-tooltip-content-with-shortcut>`}
        .tooltipOffset=${4}
        .active=${type === 'eraser'}
        @click=${() => this.setEdgelessTool({ type: 'eraser' })}
      >
        <div class="eraser-button">${icon}</div>
      </edgeless-toolbar-button>
    `;
  }
}
