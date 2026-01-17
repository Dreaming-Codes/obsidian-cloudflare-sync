import { useContext } from 'react';
import { PluginContext } from '../context/PluginContext';

/**
 * Hook to access the plugin instance and app
 */
export function usePlugin() {
	const context = useContext(PluginContext);
	if (!context) {
		throw new Error('usePlugin must be used within a PluginContext.Provider');
	}
	return context;
}

/**
 * Hook to access just the Obsidian App
 */
export function useApp() {
	const { app } = usePlugin();
	return app;
}
