import { createContext } from 'react';
import type { App } from 'obsidian';
import type CloudflareSyncPlugin from '../../main';

export interface PluginContextValue {
	app: App;
	plugin: CloudflareSyncPlugin;
}

export const PluginContext = createContext<PluginContextValue | undefined>(undefined);
