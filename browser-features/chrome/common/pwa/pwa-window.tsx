/* eslint-disable no-undef */
/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createRootHMR, render } from "@nora/solid-xul";
import { createEffect, createSignal } from "solid-js";
import { config } from "./config.ts";
import PwaWindowStyle from "./pwa-window-style.css?inline";
import PwaWindowOnelineStyle from "./pwa-window-oneline.css?inline";
import type { PwaService } from "./pwaService.ts";
import type { FloorpChromeWindow } from "./type.ts";

type TabContainer = EventTarget & {
  addEventListener(
    type: "TabOpen",
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: "TabOpen",
    listener: (event: Event) => void,
    options?: boolean | EventListenerOptions,
  ): void;
};

type GBrowser = {
  tabContainer?: TabContainer;
  tabs: XULElement[];
  removeTab(tab: XULElement): void;
};

type FloorpWindow = typeof globalThis & { gBrowser?: GBrowser };

export class PwaWindowSupport {
  private ssbId = createSignal<string | null>(null);

  private async getSsb() {
    const [ssbId] = this.ssbId;
    return ssbId ? await this.pwaService.getSsbObj(ssbId() as string) : null;
  }

  constructor(private pwaService: PwaService) {
    // Check if this is a PWA window using documentElement attribute
    // Note: We use "taskbartab" instead of "ssbid" because browser-init.js
    // only sets taskbartab attribute from extraOptions. PWA windows set both
    // with the same ID value in SsbCommandLineHandler.
    const root = document?.documentElement;
    const ssbIdAttr = root?.getAttribute("taskbartab") ??
      root?.getAttribute("ssbid");
    if (!ssbIdAttr) {
      return;
    }

    this.initializeWindow();
    this.setupSignals();
    this.initBrowser();
  }

  private async initBrowser() {
    await this.renderStyles();
    if (!this.shouldAllowTabs()) {
      await this.setupPageActions();
      this.disableUrlbarInteractions();
    } else {
      this.ensureTabbarVisible();
    }
    await this.setupTabs();
  }

  private initializeWindow(): void {
    window.floorpSsbWindow = true;
    this.configureTitlebarBehavior();
    this.updateToolbarVisibility(this.shouldShowToolbar());
  }

  private setupSignals(): void {
    const [, setSsbId] = this.ssbId;
    // Read SSB ID from documentElement attribute (using taskbartab as set by browser-init.js)
    const root = document?.documentElement;
    const ssbIdAttr = root?.getAttribute("taskbartab") ??
      root?.getAttribute("ssbid") ?? null;
    setSsbId(ssbIdAttr);
  }

  private setupPageActions(): void {
    const identityBox = document?.getElementById("identity-box");
    const pageActionBox = document?.getElementById("page-action-buttons");
    if (identityBox && pageActionBox) {
      identityBox.after(pageActionBox);
    }
  }

  private ensureTabbarVisible(): void {
    try {
      // Firefox hides the tab strip for taskbartab windows. For PWA allowTabs=true
      // we temporarily clear the taskbartab attribute when TabBarVisibility.update runs
      // so it treats the window like a normal browser window, then restore it to keep
      // session-store exclusion behavior intact.
      // deno-lint-ignore no-explicit-any
      const tbv = (window as any).TabBarVisibility;
      // deno-lint-ignore no-explicit-any
      const gNavToolbox = (window as any).gNavToolbox;
      if (!tbv || tbv.__floorpSsbPatched) {
        return;
      }

      const originalUpdate = tbv.update.bind(tbv);
      const allowTabsCheck = () => this.shouldAllowTabs();

      tbv.update = (force = false) => {
        const root = document?.documentElement;
        if (!root) {
          return originalUpdate(force);
        }

        // If allowTabs is later toggled off, fall back to default behavior.
        if (!allowTabsCheck()) {
          return originalUpdate(force);
        }

        const hadTaskbarAttr = root.hasAttribute("taskbartab");
        const taskbarValue = root.getAttribute("taskbartab");
        if (hadTaskbarAttr) {
          root.removeAttribute("taskbartab");
        }

        try {
          return originalUpdate(force);
        } finally {
          if (hadTaskbarAttr) {
            // Restore the attribute value so SessionStore keeps excluding this window.
            if (taskbarValue) {
              root.setAttribute("taskbartab", taskbarValue);
            } else {
              root.setAttribute("taskbartab", "");
            }
          }

          // Ensure tabs stay visible even if upstream tried to hide them.
          gNavToolbox?.removeAttribute("tabs-hidden");
          const doc = globalThis.document;
          doc?.getElementById("nav-bar")?.classList.remove(
            "browser-titlebar",
          );
        }
      };

      tbv.__floorpSsbPatched = true;
      tbv.update(true);
    } catch (error) {
      console.error("[PwaWindowSupport] Failed to keep tabbar visible:", error);
    }
  }

  private setupTabs(): void {
    const floorpWindow = globalThis as FloorpWindow;
    const gBrowser = floorpWindow.gBrowser;
    const tabContainer = gBrowser?.tabContainer;
    if (!tabContainer || !gBrowser) {
      return;
    }

    gBrowser.tabs.forEach((tab: XULElement) => {
      this.markTabAsSsb(tab);
    });

    tabContainer.addEventListener("TabOpen", this.handleTabOpen);
    globalThis.addEventListener("unload", () => {
      tabContainer.removeEventListener("TabOpen", this.handleTabOpen);
    });
  }

  private renderStyles(): void {
    createRootHMR(() => {
      render(() => this.createStyleElement(), document?.head);
    }, import.meta.hot);
  }

  private configureTitlebarBehavior(): void {
    try {
      const chromeWindow = window as FloorpChromeWindow;
      const customTitlebar = chromeWindow.CustomTitlebar;
      if (!customTitlebar?.allowedBy) {
        return;
      }

      if (!customTitlebar.__floorpSsbPatched) {
        const originalAllowedBy = customTitlebar.allowedBy.bind(customTitlebar);
        customTitlebar.allowedBy = (condition: string, allow: boolean) => {
          if (condition === "non-popup") {
            originalAllowedBy(
              condition,
              this.shouldUseCustomTitlebar(),
            );
            return;
          }
          originalAllowedBy(condition, allow);
        };
        customTitlebar.__floorpSsbPatched = true;
      }

      createRootHMR(() => {
        createEffect(() => {
          const showToolbar = this.shouldShowToolbar();
          // When the toolbar is hidden we want the window to use the native titlebar.
          customTitlebar.allowedBy("non-popup", this.shouldUseCustomTitlebar());
          this.updateToolbarVisibility(showToolbar);
        });
      }, import.meta.hot);
    } catch (error) {
      console.error(
        "[PwaWindowSupport] Failed to configure titlebar behavior:",
        error,
      );
    }
  }

  private shouldShowToolbar(): boolean {
    return config().showToolbar !== false;
  }

  private shouldAllowTabs(): boolean {
    return config().allowTabs === true;
  }

  private shouldUseCustomTitlebar(): boolean {
    return this.shouldShowToolbar();
  }

  private createStyleElement() {
    const showToolbar = this.shouldShowToolbar();
    const styles: string[] = [];

    if (!this.shouldAllowTabs()) {
      styles.push(PwaWindowStyle);
    } else {
      styles.push(PwaWindowOnelineStyle);
    }

    if (!showToolbar) {
      styles.push(`
           #nav-bar, #status-bar, #PersonalToolbar, #titlebar {
             display: none;
           }
         `);
    }

    return <style>{styles.join("\n")}</style>;
  }

  private disableUrlbarInteractions(): void {
    if (this.shouldAllowTabs()) {
      return;
    }
    try {
      const doc = globalThis.document;
      if (!doc) {
        return;
      }

      const urlbarInput = doc.getElementById(
        "urlbar-input",
      ) as HTMLInputElement | null;
      if (urlbarInput) {
        urlbarInput.readOnly = true;
        urlbarInput.setAttribute("aria-readonly", "true");
      }
    } catch (error) {
      console.error(
        "[PwaWindowSupport] Failed to disable urlbar interactions:",
        error,
      );
    }
  }

  private markTabAsSsb(tab: XULElement | null): void {
    if (!tab) {
      return;
    }
    tab.setAttribute("floorpSSB", "true");
  }

  private handleTabOpen = (event: Event): void => {
    const tab = event.target as XULElement | null;

    if (!this.shouldAllowTabs()) {
      // Force single-tab PWA windows by immediately closing any new tabs.
      const gBrowser = (globalThis as FloorpWindow).gBrowser;
      if (gBrowser && tab) {
        globalThis.setTimeout(() => {
          try {
            gBrowser.removeTab(tab);
          } catch (error) {
            console.error(
              "[PwaWindowSupport] Failed to close extra tab:",
              error,
            );
          }
        });
      }
      return;
    }

    this.markTabAsSsb(tab);
  };

  private updateToolbarVisibility(showToolbar: boolean): void {
    try {
      const doc = globalThis.document;
      if (!doc) {
        return;
      }

      const elements = [
        doc.getElementById("nav-bar"),
        doc.getElementById("status-bar"),
        doc.getElementById("PersonalToolbar"),
      ];

      for (const element of elements) {
        if (!element) {
          continue;
        }

        element.removeAttribute("hidden");
        element.removeAttribute("collapsed");
        element.removeAttribute("style");

        if (!showToolbar) {
          element.setAttribute("hidden", "true");
          element.setAttribute("collapsed", "true");
          element.setAttribute("style", "display: none;");
        }
      }
    } catch (error) {
      console.error(
        "[PwaWindowSupport] Failed to update toolbar visibility:",
        error,
      );
    }
  }

  public get ssbWindowId(): string | null {
    const [ssbId] = this.ssbId;
    return ssbId();
  }

  public async getSsbObj(id: string) {
    return await this.pwaService.getSsbObj(id);
  }
}
