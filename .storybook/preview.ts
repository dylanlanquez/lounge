import type { Preview } from '@storybook/react';
import { applyGlobalStyles } from '../src/theme/globalStyles.ts';

applyGlobalStyles();

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: 'cream',
      values: [
        { name: 'cream', value: '#F7F6F2' },
        { name: 'surface', value: '#FFFFFF' },
        { name: 'ink', value: '#0E1414' },
      ],
    },
    controls: {
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
  },
};
export default preview;
