import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Desk } from './App.tsx';
import { Landing } from './Landing.tsx';
import { usePath } from './ui.tsx';

function Root() {
  const path = usePath();
  return path.startsWith('/app') ? <Desk path={path} /> : <Landing />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
