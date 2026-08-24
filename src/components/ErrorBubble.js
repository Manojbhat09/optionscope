// src/components/ErrorBubble.js
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import React, { useEffect, useState } from 'react';

// Floating, dismissible toast for surfacing an error right after the action
// that caused it, instead of (or in addition to) a small inline text note
// that's easy to miss. Watches `message` and re-opens the bubble every time
// it changes to a new non-empty string, even if the previous bubble was
// already dismissed — so re-clicking the same failing button re-notifies.
export default function ErrorBubble({ message, onClose, autoHideDuration = 8000 }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (message) setOpen(true);
  }, [message]);

  const handleClose = (_event, reason) => {
    if (reason === 'clickaway') return;
    setOpen(false);
    onClose?.();
  };

  return (
    <Snackbar
      open={open && !!message}
      autoHideDuration={autoHideDuration}
      onClose={handleClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert onClose={handleClose} severity="error" variant="filled" sx={{ maxWidth: 480 }}>
        {message}
      </Alert>
    </Snackbar>
  );
}
