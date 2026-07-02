import path from 'path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		fs: {
			allow: [path.resolve(__dirname, '..')],
		},
		port: 5173,
		strictPort: true,
	},
});
