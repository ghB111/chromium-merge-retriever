import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App';
import AdminPanel from './pages/AdminPanel';
import AdminDebugPage from './pages/AdminDebugPage';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/admin" element={<AdminPanel />} />
        <Route path="/admin/debug" element={<AdminDebugPage />} />
        <Route path="/admin/debug/:sessionId" element={<AdminDebugPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
