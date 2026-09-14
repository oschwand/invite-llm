import './style.css'
import Alpine from 'alpinejs'
import { loginForm } from './login.ts'

Alpine.data('loginForm', loginForm)

Alpine.start()
