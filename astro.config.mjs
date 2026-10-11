// @ts-check

import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: 'https://example.com',
	integrations: [sitemap()],
	redirects: {
		'/my-experience-learning-to-write-shaders.html': '/blog/writing-shaders',
		'/bridging-java-to-c-idiomatic-differences-and-best-practices.html': '/blog/java-cpp',
		'/removing-outliers-for-machine-learning.html': '/blog/removing-outliers',
		'/what-rust-taught-me-about-writing-better-c.html': '/blog/rust-cpp',
	},
	fonts: [
		{
			provider: fontProviders.local(),
			name: 'Atkinson',
			cssVariable: '--font-atkinson',
			fallbacks: ['sans-serif'],
			options: {
				variants: [
					{
						src: ['./src/assets/fonts/atkinson-regular.woff'],
						weight: 400,
						style: 'normal',
						display: 'swap',
					},
					{
						src: ['./src/assets/fonts/atkinson-bold.woff'],
						weight: 700,
						style: 'normal',
						display: 'swap',
					},
				],
			},
		},
	],
});
