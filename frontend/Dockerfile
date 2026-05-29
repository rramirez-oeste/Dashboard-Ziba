# Usamos Nginx para servir los archivos estáticos HTML/CSS/JS
FROM nginx:alpine

COPY . /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# Nginx se inicia automáticamente, no necesitamos un comando CMD explícito