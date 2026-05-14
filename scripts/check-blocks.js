document.querySelectorAll('[aria-label="bugger code"]').forEach((e,i)=>console.log(i,e.getAttribute('data-bugger-handled'),e.textContent.slice(0,60)));
