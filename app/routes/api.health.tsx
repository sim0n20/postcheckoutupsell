import type {LoaderFunctionArgs} from "react-router";
import prisma from "../db.server";
export async function loader(_:LoaderFunctionArgs){try{await prisma.$queryRaw`SELECT 1`;return Response.json({ok:true},{headers:{"Cache-Control":"no-store"}})}catch{return Response.json({ok:false},{status:503,headers:{"Cache-Control":"no-store"}})}}
