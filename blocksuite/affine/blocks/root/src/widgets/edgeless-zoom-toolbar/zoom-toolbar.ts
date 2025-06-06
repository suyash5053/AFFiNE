import { stopPropagation } from '@blocksuite/affine-shared/utils';
import { WithDisposable } from '@blocksuite/global/lit';
import { MinusIcon, PlusIcon, ViewBarIcon } from '@blocksuite/icons/lit';
import { ZOOM_STEP } from '@blocksuite/std/gfx';
import { effect } from '@preact/signals-core';
import { baseTheme } from '@toeverything/theme';
import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { property } from 'lit/decorators.js';

import type { EdgelessRootBlockComponent } from '../../edgeless/edgeless-root-block.js';

export class EdgelessZoomToolbar extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      display: flex;
    }

    .edgeless-zoom-toolbar-container {
      display: flex;
      align-items: center;
      background: transparent;
      border-radius: 8px;
      fill: currentcolor;
      padding: 4px;
    }

    .edgeless-zoom-toolbar-container.horizantal {
      flex-direction: row;
    }

    .edgeless-zoom-toolbar-container.vertical {
      flex-direction: column;
      width: 40px;
      background-color: var(--affine-background-overlay-panel-color);
      box-shadow: var(--affine-shadow-2);
      border: 1px solid var(--affine-border-color);
      border-radius: 8px;
    }

    .edgeless-zoom-toolbar-container[level='second'] {
      position: absolute;
      bottom: 8px;
      transform: translateY(-100%);
    }

    .edgeless-zoom-toolbar-container[hidden] {
      display: none;
    }

    .zoom-percent {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 32px;
      border: none;
      box-sizing: border-box;
      padding: 4px;
      color: var(--affine-icon-color);
      background-color: transparent;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 500;
      text-align: center;
      font-family: ${unsafeCSS(baseTheme.fontSansFamily)};
    }

    .zoom-percent:hover {
      color: var(--affine-primary-color);
      background-color: var(--affine-hover-color);
    }

    .zoom-percent[disabled] {
      pointer-events: none;
      cursor: not-allowed;
      color: var(--affine-text-disable-color);
    }
  `;

  get edgelessService() {
    return this.edgeless.service;
  }

  get gfx() {
    return this.edgeless.gfx;
  }

  get edgelessTool() {
    return this.edgeless.gfx.tool.currentToolOption$.peek();
  }

  get locked() {
    return this.edgelessService.locked;
  }

  get viewport() {
    return this.edgelessService.viewport;
  }

  get zoom() {
    if (!this.viewport) {
      console.error('Something went wrong, viewport is not available');
      return 1;
    }
    return this.viewport.zoom;
  }

  constructor(edgeless: EdgelessRootBlockComponent) {
    super();
    this.edgeless = edgeless;
  }

  private _isVerticalBar() {
    return this.layout === 'vertical';
  }

  override connectedCallback() {
    super.connectedCallback();

    this.disposables.add(
      effect(() => {
        this.edgeless.gfx.tool.currentToolName$.value;
        this.requestUpdate();
      })
    );
  }

  override firstUpdated() {
    const { disposables } = this;
    disposables.add(
      this.edgeless.service.viewport.viewportUpdated.subscribe(() =>
        this.requestUpdate()
      )
    );
    disposables.add(
      this.edgeless.slots.readonlyUpdated.subscribe(() => {
        this.requestUpdate();
      })
    );
  }

  override render() {
    if (this.edgeless.doc.readonly) {
      return nothing;
    }

    const formattedZoom = `${Math.round(this.zoom * 100)}%`;
    const classes = `edgeless-zoom-toolbar-container ${this.layout}`;
    const locked = this.locked;

    return html`
      <div
        class=${classes}
        @dblclick=${stopPropagation}
        @mousedown=${stopPropagation}
        @mouseup=${stopPropagation}
        @pointerdown=${stopPropagation}
      >
        <edgeless-tool-icon-button
          .tooltip=${'Fit to screen'}
          .tipPosition=${this._isVerticalBar() ? 'right' : 'top-end'}
          .arrow=${!this._isVerticalBar()}
          @click=${() => this.gfx.fitToScreen()}
          .iconContainerPadding=${4}
          .iconSize=${'24px'}
          .disabled=${locked}
        >
          ${ViewBarIcon()}
        </edgeless-tool-icon-button>
        <edgeless-tool-icon-button
          .tooltip=${'Zoom out'}
          .tipPosition=${this._isVerticalBar() ? 'right' : 'top'}
          .arrow=${!this._isVerticalBar()}
          @click=${() => this.edgelessService.setZoomByStep(-ZOOM_STEP)}
          .iconContainerPadding=${4}
          .iconSize=${'24px'}
          .disabled=${locked}
        >
          ${MinusIcon()}
        </edgeless-tool-icon-button>
        <button
          class="zoom-percent"
          @click=${() => this.viewport.smoothZoom(1)}
          .disabled=${locked}
        >
          ${formattedZoom}
        </button>
        <edgeless-tool-icon-button
          .tooltip=${'Zoom in'}
          .tipPosition=${this._isVerticalBar() ? 'right' : 'top'}
          .arrow=${!this._isVerticalBar()}
          @click=${() => this.edgelessService.setZoomByStep(ZOOM_STEP)}
          .iconContainerPadding=${4}
          .iconSize=${'24px'}
          .disabled=${locked}
        >
          ${PlusIcon()}
        </edgeless-tool-icon-button>
      </div>
    `;
  }

  @property({ attribute: false })
  accessor edgeless: EdgelessRootBlockComponent;

  @property({ attribute: false })
  accessor layout: 'horizontal' | 'vertical' = 'horizontal';
}
