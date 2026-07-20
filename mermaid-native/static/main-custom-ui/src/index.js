import React from 'react';
import { createRoot } from 'react-dom/client';
import '@atlaskit/css-reset';
import App from './App';

const root = createRoot(document.getElementById('root'));
root.render(<App />);
