import { render } from 'preact';
import { App } from './app/App';
import './app/app.css';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
render(<App />, root);
