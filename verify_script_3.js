
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            serif: ['Georgia', 'Cambria', 'serif'],
            sans: ['Inter', 'system-ui', 'sans-serif'],
            mono: ['Courier New', 'monospace']
          }
        }
      }
    };
  