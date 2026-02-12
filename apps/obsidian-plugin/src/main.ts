import { Plugin } from 'obsidian';
import { CopilotView, VIEW_TYPE_COPILOT } from './views/CopilotView';

export default class CopilotPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE_COPILOT, (leaf) => new CopilotView(leaf, this));
    this.addRibbonIcon('bot', 'Open Copilot', () => { this.activateView(); });
    this.addCommand({ id: 'open-copilot', name: 'Open Copilot', callback: () => this.activateView() });
  }

  async activateView() {
    const { workspace } = this.app;
    workspace.detachLeavesOfType(VIEW_TYPE_COPILOT);
    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_COPILOT, active: true });
      workspace.revealLeaf(leaf);
    }
  }

  onunload() {}
}
