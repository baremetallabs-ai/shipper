import ReactDOM from 'react-dom/client';

import App from './App.js';
import './globals.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Renderer root element not found.');
}

ReactDOM.createRoot(root).render(<App />);
