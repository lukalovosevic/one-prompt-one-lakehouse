import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
	plugins: [react()],
	server: {
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'credentialless',
		},
	},
	resolve: {
		alias: {
			'@motherduck/react-sql-query': path.resolve(__dirname, 'src/md-sdk.tsx'),
		},
	},
});
