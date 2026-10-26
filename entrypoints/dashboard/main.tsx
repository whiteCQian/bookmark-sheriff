import { createRoot } from 'react-dom/client';
import { DashboardApp } from '../../src/ui/DashboardApp';
import '../../src/styles.css';

createRoot(document.getElementById('root')!).render(<DashboardApp />);
